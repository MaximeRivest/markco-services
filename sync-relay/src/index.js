/**
 * Sync Relay — markco.dev's persistent sync service
 *
 * This is a thin wrapper that starts mrmd-sync with:
 *   - Postgres storage backend (instead of filesystem)
 *   - Auth via X-User-Id (proxy) or session token (direct)
 *   - Multi-user document routing (userId/project/docPath)
 *   - HTTP API for listing/fetching documents (used by editor container seeding)
 *
 * It is NOT a separate Yjs implementation — it IS mrmd-sync.
 * Same code that runs on desktop, same protocol, just different storage.
 */

import pg from 'pg';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'mrmd-sync';
import { createPostgresStorage } from 'mrmd-sync/src/storage-postgres.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SYNC_RELAY_PORT || process.env.PORT || '3006', 10);

// ─── Database ───────────────────────────────────────────────────────────────

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/markco',
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('[sync-relay] Pool error:', err.message);
});

async function initSchema() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
  await pool.query(sql);
  console.log('[sync-relay] Schema initialized');
}

// ─── Auth ───────────────────────────────────────────────────────────────────

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const tokenValidationCache = new Map();

function extractBearerToken(req) {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  return null;
}

function getDocUserId(docName) {
  if (!docName) return null;
  const [uid] = docName.split('/');
  return uid || null;
}

async function validateToken(token) {
  const now = Date.now();
  const cached = tokenValidationCache.get(token);
  if (cached && cached.expiresAt > now) {
    return cached.userId;
  }

  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/auth/validate`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      tokenValidationCache.set(token, { userId: null, expiresAt: now + 10000 });
      return null;
    }

    const data = await res.json();
    const userId = data?.user?.id || null;
    tokenValidationCache.set(token, { userId, expiresAt: now + 60000 });
    return userId;
  } catch (err) {
    console.warn('[sync-relay] Token validation failed:', err.message);
    tokenValidationCache.set(token, { userId: null, expiresAt: now + 5000 });
    return null;
  }
}

/**
 * Auth hook for mrmd-sync WebSocket connections.
 */
async function authHandler(req, docName) {
  if (process.env.SYNC_RELAY_NO_AUTH === '1') return true;

  const headerUserId = req.headers['x-user-id'];
  const url = new URL(req.url, 'http://localhost');
  const tokenParam = url.searchParams.get('token');
  const bearerToken = extractBearerToken(req);
  const token = bearerToken || tokenParam;

  const docUserId = getDocUserId(docName);

  // Trusted proxy path: orchestrator already validated cookie.
  if (headerUserId) {
    return !docUserId || docUserId === headerUserId;
  }

  // Direct path: validate session token against auth-service.
  if (!token) return false;

  const validatedUserId = await validateToken(token);
  if (!validatedUserId) return false;

  // Enforce tenant isolation in room path.
  return !docUserId || docUserId === validatedUserId;
}

// ─── HTTP API for document listing ──────────────────────────────────────────

/**
 * Authenticate HTTP API requests.
 * Accepts X-User-Id header (trusted internal) or Bearer token.
 * Returns the validated userId or null.
 */
async function authenticateHttpRequest(req) {
  if (process.env.SYNC_RELAY_NO_AUTH === '1') return 'anonymous';

  const headerUserId = req.headers['x-user-id'];
  if (headerUserId) return headerUserId;

  const bearerToken = extractBearerToken(req);
  const url = new URL(req.url, 'http://localhost');
  const tokenParam = url.searchParams.get('token');
  const token = bearerToken || tokenParam;

  if (!token) return null;
  return await validateToken(token);
}

/**
 * Handle HTTP API requests for document listing.
 * Returns true if the request was handled, false to fall through.
 */
async function handleApiRequest(req, res, url) {
  // Only handle /api/documents/* paths
  const match = url.pathname.match(/^\/api\/documents\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return false;

  const [, requestedUserId, project] = match;

  // Authenticate
  const authedUserId = await authenticateHttpRequest(req);
  if (!authedUserId) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return true;
  }

  // Enforce tenant isolation: can only list own documents
  if (authedUserId !== 'anonymous' && authedUserId !== requestedUserId) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return true;
  }

  const includeContent = url.searchParams.get('content') === '1';
  const includeYjs = url.searchParams.get('yjs') === '1';

  try {
    let query, params;

    if (project) {
      // List docs in a specific project
      const selectCols = ['doc_path', 'content_hash', 'byte_size', 'updated_at'];
      if (includeContent) selectCols.push('content_text');
      if (includeYjs) selectCols.push('encode(yjs_state, \'base64\') as yjs_state_b64');

      query = `SELECT ${selectCols.join(', ')} FROM documents
               WHERE user_id = $1 AND project = $2
               ORDER BY doc_path`;
      params = [requestedUserId, project];
    } else {
      // List all projects and their doc counts
      query = `SELECT project, doc_path, content_hash, byte_size, updated_at
               FROM documents
               WHERE user_id = $1
               ORDER BY project, doc_path`;
      params = [requestedUserId];
    }

    const { rows } = await pool.query(query, params);

    if (project) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        userId: requestedUserId,
        project,
        documents: rows.map(r => ({
          docPath: r.doc_path,
          contentHash: r.content_hash,
          byteSize: r.byte_size,
          updatedAt: r.updated_at,
          ...(includeContent && { content: r.content_text }),
          ...(includeYjs && { yjsState: r.yjs_state_b64 }),
        })),
      }));
    } else {
      // Group by project
      const projects = {};
      for (const row of rows) {
        if (!projects[row.project]) {
          projects[row.project] = { docCount: 0, documents: [] };
        }
        projects[row.project].docCount++;
        projects[row.project].documents.push({
          docPath: row.doc_path,
          contentHash: row.content_hash,
          byteSize: row.byte_size,
          updatedAt: row.updated_at,
        });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        userId: requestedUserId,
        projects,
      }));
    }

    return true;
  } catch (err) {
    console.error('[sync-relay] API error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
    return true;
  }
}

// ─── Runtime Tunnel ─────────────────────────────────────────────────────────
//
// Allows the Electron desktop app to expose its local runtime (bash, PTY,
// Python) to the web editor via the relay. When the Electron has a project
// open, it connects to ws://relay/tunnel/<userId> as a "provider". The web
// editor connects as a "consumer". Messages are forwarded between them.
//
// Protocol: JSON text messages. See runtime-tunnel.js for message types.
// PTY data is base64-encoded inside JSON for simplicity.
//
// Room key: userId (one tunnel per user — the provider handles all projects)

/** @type {Map<string, { provider: WebSocket|null, consumers: Set<WebSocket> }>} */
const tunnelRooms = new Map();

function getTunnelRoom(userId) {
  if (!tunnelRooms.has(userId)) {
    tunnelRooms.set(userId, { provider: null, consumers: new Set() });
  }
  return tunnelRooms.get(userId);
}

/**
 * Handle a WebSocket connection to /tunnel/<userId>.
 * The first query param `role=provider` marks the Electron side.
 * All others are consumers (web editor).
 */
function handleTunnelConnection(ws, req) {
  const url = new URL(req.url, 'http://localhost');
  const pathParts = url.pathname.replace(/^\/tunnel\/?/, '').split('/');
  const userId = decodeURIComponent(pathParts[0] || '');

  if (!userId) {
    ws.close(1008, 'Missing userId in tunnel path');
    return;
  }

  // Auth: X-User-Id header or validated token
  const headerUserId = req.headers['x-user-id'];
  if (headerUserId && headerUserId !== userId) {
    ws.close(1008, 'User ID mismatch');
    return;
  }

  const role = url.searchParams.get('role');
  const room = getTunnelRoom(userId);

  if (role === 'provider') {
    // Electron desktop app
    if (room.provider && room.provider.readyState === 1) {
      // Replace stale provider
      try { room.provider.close(1000, 'Replaced by new provider'); } catch {}
    }
    room.provider = ws;
    console.log(`[tunnel] Provider connected for user ${userId}`);

    ws.on('message', (data) => {
      // Forward provider messages to all consumers
      const msg = typeof data === 'string' ? data : data.toString();
      for (const consumer of room.consumers) {
        if (consumer.readyState === 1) {
          try { consumer.send(msg); } catch {}
        }
      }
    });

    ws.on('close', () => {
      if (room.provider === ws) {
        room.provider = null;
        console.log(`[tunnel] Provider disconnected for user ${userId}`);
        // Notify consumers that provider is gone
        const gone = JSON.stringify({ t: 'provider-gone' });
        for (const consumer of room.consumers) {
          try { consumer.send(gone); } catch {}
        }
      }
    });
  } else {
    // Web editor (consumer)
    room.consumers.add(ws);
    console.log(`[tunnel] Consumer connected for user ${userId} (${room.consumers.size} total)`);

    // Tell consumer if provider is available
    const status = JSON.stringify({
      t: 'provider-status',
      available: !!(room.provider && room.provider.readyState === 1),
    });
    ws.send(status);

    ws.on('message', (data) => {
      // Forward consumer messages to provider
      if (room.provider && room.provider.readyState === 1) {
        const msg = typeof data === 'string' ? data : data.toString();
        try { room.provider.send(msg); } catch {}
      }
    });

    ws.on('close', () => {
      room.consumers.delete(ws);
      console.log(`[tunnel] Consumer disconnected for user ${userId} (${room.consumers.size} remaining)`);
    });
  }

  ws.on('error', () => { /* handled by close */ });
}

/**
 * Handle tunnel status HTTP API.
 * GET /api/tunnel/<userId> → { available: bool, consumers: number }
 */
async function handleTunnelApiRequest(req, res, url) {
  const match = url.pathname.match(/^\/api\/tunnel\/([^/]+)$/);
  if (!match) return false;

  const userId = decodeURIComponent(match[1]);
  const authedUserId = await authenticateHttpRequest(req);
  if (!authedUserId) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return true;
  }

  const room = tunnelRooms.get(userId);
  const available = !!(room?.provider && room.provider.readyState === 1);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ available, consumers: room?.consumers.size || 0 }));
  return true;
}

// ─── Start ──────────────────────────────────────────────────────────────────

async function start() {
  console.log('[sync-relay] Starting...');

  // Initialize DB schema
  await initSchema();

  // Create Postgres storage backend
  const storage = createPostgresStorage({ pool });

  // Start mrmd-sync with Postgres storage + custom HTTP handler + tunnel
  const server = createServer({
    dir: '/tmp/sync-relay-noop',
    port: PORT,
    auth: authHandler,
    storage,
    pathPrefix: '/sync',
    onRequest: async (req, res, url) => {
      // Try tunnel API first
      if (await handleTunnelApiRequest(req, res, url)) return true;
      // Then document API
      return handleApiRequest(req, res, url);
    },
    onConnection: async (ws, req) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/tunnel/')) {
        handleTunnelConnection(ws, req);
        return true; // Handled — don't pass to Yjs handler
      }
      return false;
    },
    debounceMs: 2000,
    maxConnections: 200,
    docCleanupDelayMs: 60000,
    dangerouslyAllowSystemPaths: true,
    logLevel: process.env.LOG_LEVEL || 'info',
    persistYjsState: false,
  });

  console.log(`[sync-relay] Listening on :${PORT}`);
  console.log(`[sync-relay] Storage: postgres`);
  console.log(`[sync-relay] WebSocket: ws://localhost:${PORT}/sync/<userId>/<project>/<docPath>`);
  console.log(`[sync-relay] Tunnel: ws://localhost:${PORT}/tunnel/<userId>?role=provider|consumer`);
  console.log(`[sync-relay] HTTP API: http://localhost:${PORT}/api/documents/<userId>[/<project>]`);
}

start().catch(err => {
  console.error('[sync-relay] Fatal:', err);
  process.exit(1);
});
