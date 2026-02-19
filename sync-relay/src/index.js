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

// ─── Machine Registry + File Catalog ────────────────────────────────────────
//
// Machines push lightweight file manifests so the web editor can browse
// projects from all connected machines without needing per-doc WebSocket
// bridges for every file.

/**
 * Upsert machine into the registry.
 */
async function upsertMachine(userId, machineId, { machineName, hostname, capabilities, status }) {
  await pool.query(
    `INSERT INTO machines (user_id, machine_id, machine_name, hostname, capabilities, status, last_seen, connected_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
     ON CONFLICT (user_id, machine_id)
     DO UPDATE SET machine_name = COALESCE($3, machines.machine_name),
                   hostname = COALESCE($4, machines.hostname),
                   capabilities = COALESCE($5, machines.capabilities),
                   status = $6,
                   last_seen = NOW(),
                   connected_at = CASE WHEN $6 = 'online' AND machines.status != 'online'
                                       THEN NOW() ELSE machines.connected_at END`,
    [userId, machineId, machineName || null, hostname || null, capabilities || [], status || 'online']
  );
}

/**
 * Set machine offline.
 */
async function setMachineOffline(userId, machineId) {
  await pool.query(
    `UPDATE machines SET status = 'offline', last_seen = NOW() WHERE user_id = $1 AND machine_id = $2`,
    [userId, machineId]
  );
}

/**
 * Bulk-replace catalog for a machine. Accepts an array of {project, docPath, contentHash, byteSize}.
 * Deletes entries that are no longer present (clean diff).
 */
async function syncCatalog(userId, machineId, entries) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Delete all existing entries for this machine
    await client.query(
      `DELETE FROM catalog WHERE user_id = $1 AND machine_id = $2`,
      [userId, machineId]
    );

    // Batch insert new entries (chunks of 500 to stay within param limits)
    const CHUNK = 500;
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      let idx = 1;
      for (const e of chunk) {
        values.push(`($${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, $${idx++}, NOW())`);
        params.push(userId, machineId, e.project, e.docPath, e.contentHash || null, e.byteSize || 0);
      }
      await client.query(
        `INSERT INTO catalog (user_id, machine_id, project, doc_path, content_hash, byte_size, updated_at)
         VALUES ${values.join(', ')}`,
        params
      );
    }

    // Also update last_seen on the machine
    await client.query(
      `UPDATE machines SET last_seen = NOW() WHERE user_id = $1 AND machine_id = $2`,
      [userId, machineId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Handle catalog + machine HTTP API requests.
 * Routes:
 *   POST /api/catalog/<userId>/<machineId>  — bulk upsert file listing
 *   GET  /api/catalog/<userId>              — list all machines + projects
 *   GET  /api/catalog/<userId>?project=X    — list docs for project X across machines
 *   GET  /api/machines/<userId>             — list machines with status
 */
async function handleCatalogApiRequest(req, res, url) {
  // ── POST /api/catalog/<userId>/<machineId> — push file manifest
  const postMatch = url.pathname.match(/^\/api\/catalog\/([^/]+)\/([^/]+)$/);
  if (postMatch && req.method === 'POST') {
    const [, requestedUserId, machineId] = postMatch;

    const authedUserId = await authenticateHttpRequest(req);
    if (!authedUserId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    if (authedUserId !== 'anonymous' && authedUserId !== requestedUserId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return true;
    }

    // Read JSON body
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }

    const { machineName, hostname, capabilities, entries } = payload;
    if (!Array.isArray(entries)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'entries array required' }));
      return true;
    }

    try {
      await upsertMachine(requestedUserId, machineId, {
        machineName, hostname, capabilities, status: 'online',
      });
      await syncCatalog(requestedUserId, machineId, entries);

      console.log(`[catalog] Synced ${entries.length} entries for ${machineId} (user ${requestedUserId.slice(0, 8)})`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries: entries.length }));
    } catch (err) {
      console.error('[catalog] Sync error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return true;
  }

  // ── GET /api/catalog/<userId> — list all machines + their projects/docs
  const getMatch = url.pathname.match(/^\/api\/catalog\/([^/]+)$/);
  if (getMatch && req.method === 'GET') {
    const [, requestedUserId] = getMatch;

    const authedUserId = await authenticateHttpRequest(req);
    if (!authedUserId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    if (authedUserId !== 'anonymous' && authedUserId !== requestedUserId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return true;
    }

    const projectFilter = url.searchParams.get('project');

    try {
      // Fetch machines
      const { rows: machineRows } = await pool.query(
        `SELECT machine_id, machine_name, hostname, capabilities, status, last_seen, connected_at
         FROM machines WHERE user_id = $1 ORDER BY machine_name, machine_id`,
        [requestedUserId]
      );

      // Fetch catalog entries
      let catalogQuery, catalogParams;
      if (projectFilter) {
        catalogQuery = `SELECT machine_id, project, doc_path, content_hash, byte_size, updated_at
                        FROM catalog WHERE user_id = $1 AND project = $2
                        ORDER BY machine_id, project, doc_path`;
        catalogParams = [requestedUserId, projectFilter];
      } else {
        catalogQuery = `SELECT machine_id, project, doc_path, content_hash, byte_size, updated_at
                        FROM catalog WHERE user_id = $1
                        ORDER BY machine_id, project, doc_path`;
        catalogParams = [requestedUserId];
      }
      const { rows: catalogRows } = await pool.query(catalogQuery, catalogParams);

      // Group catalog by machine → project → docs
      const catalogByMachine = {};
      for (const row of catalogRows) {
        if (!catalogByMachine[row.machine_id]) catalogByMachine[row.machine_id] = {};
        if (!catalogByMachine[row.machine_id][row.project]) catalogByMachine[row.machine_id][row.project] = [];
        catalogByMachine[row.machine_id][row.project].push({
          docPath: row.doc_path,
          contentHash: row.content_hash,
          byteSize: row.byte_size,
          updatedAt: row.updated_at,
        });
      }

      const machines = machineRows.map(m => ({
        machineId: m.machine_id,
        machineName: m.machine_name,
        hostname: m.hostname,
        capabilities: m.capabilities || [],
        status: m.status,
        lastSeen: m.last_seen,
        connectedAt: m.connected_at,
        projects: Object.entries(catalogByMachine[m.machine_id] || {}).map(([name, docs]) => ({
          name,
          docCount: docs.length,
          documents: docs,
        })),
      }));

      // Also include cloud-only projects (in documents table but not in any machine's catalog)
      const { rows: cloudProjects } = await pool.query(
        `SELECT DISTINCT project FROM documents WHERE user_id = $1
         EXCEPT
         SELECT DISTINCT project FROM catalog WHERE user_id = $1`,
        [requestedUserId]
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        userId: requestedUserId,
        machines,
        cloudOnlyProjects: cloudProjects.map(r => r.project),
      }));
    } catch (err) {
      console.error('[catalog] Query error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return true;
  }

  // ── GET /api/machines/<userId> — compact machine list
  const machinesMatch = url.pathname.match(/^\/api\/machines\/([^/]+)$/);
  if (machinesMatch && req.method === 'GET') {
    const [, requestedUserId] = machinesMatch;

    const authedUserId = await authenticateHttpRequest(req);
    if (!authedUserId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }
    if (authedUserId !== 'anonymous' && authedUserId !== requestedUserId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return true;
    }

    try {
      const { rows } = await pool.query(
        `SELECT m.machine_id, m.machine_name, m.hostname, m.capabilities, m.status,
                m.last_seen, m.connected_at,
                COUNT(c.doc_path) as doc_count,
                COUNT(DISTINCT c.project) as project_count
         FROM machines m
         LEFT JOIN catalog c ON c.user_id = m.user_id AND c.machine_id = m.machine_id
         WHERE m.user_id = $1
         GROUP BY m.machine_id, m.machine_name, m.hostname, m.capabilities,
                  m.status, m.last_seen, m.connected_at
         ORDER BY m.machine_name, m.machine_id`,
        [requestedUserId]
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        userId: requestedUserId,
        machines: rows.map(r => ({
          machineId: r.machine_id,
          machineName: r.machine_name,
          hostname: r.hostname,
          capabilities: r.capabilities || [],
          status: r.status,
          lastSeen: r.last_seen,
          connectedAt: r.connected_at,
          projectCount: parseInt(r.project_count, 10),
          docCount: parseInt(r.doc_count, 10),
        })),
      }));
    } catch (err) {
      console.error('[machines] Query error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
    return true;
  }

  return false;
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

/**
 * Multi-provider tunnel rooms.
 * Each user can have multiple machines connected as providers simultaneously.
 * One is marked "active" and receives consumer runtime traffic.
 *
 * @type {Map<string, {
 *   providers: Map<string, { ws: WebSocket, meta: object }>,
 *   activeMachineId: string|null,
 *   consumers: Set<WebSocket>
 * }>}
 */
const tunnelRooms = new Map();

function getTunnelRoom(userId) {
  if (!tunnelRooms.has(userId)) {
    tunnelRooms.set(userId, {
      providers: new Map(),
      activeMachineId: null,
      consumers: new Set(),
    });
  }
  return tunnelRooms.get(userId);
}

/** Get the active provider entry (ws + meta) or null. */
function getActiveProvider(room) {
  if (!room.activeMachineId) return null;
  const entry = room.providers.get(room.activeMachineId);
  if (entry && entry.ws.readyState === 1) return entry;
  return null;
}

/** Auto-select an active provider if none is set or current one is gone. */
function autoSelectActive(room) {
  // If current active is still connected, keep it
  const current = room.activeMachineId ? room.providers.get(room.activeMachineId) : null;
  if (current && current.ws.readyState === 1) return;

  // Pick the first connected provider
  for (const [machineId, entry] of room.providers) {
    if (entry.ws.readyState === 1) {
      room.activeMachineId = machineId;
      console.log(`[tunnel] Auto-selected active machine: ${machineId}`);
      return;
    }
  }

  // No providers available
  room.activeMachineId = null;
}

/** Build list of all providers with status for consumer notification. */
function buildMachineList(room) {
  const machines = [];
  for (const [machineId, entry] of room.providers) {
    machines.push({
      machineId,
      ...entry.meta,
      active: machineId === room.activeMachineId,
      connected: entry.ws.readyState === 1,
    });
  }
  return machines;
}

/** Notify all consumers about current machine state. */
function notifyConsumers(room) {
  const active = getActiveProvider(room);
  const status = JSON.stringify({
    t: 'provider-status',
    available: !!active,
    provider: active?.meta || null,
    activeMachineId: room.activeMachineId,
    machines: buildMachineList(room),
  });
  for (const consumer of room.consumers) {
    if (consumer.readyState === 1) {
      try { consumer.send(status); } catch {}
    }
  }
}

function buildProviderMeta(req, url, existing = {}) {
  return {
    machineId: url.searchParams.get('machine_id') || existing.machineId || null,
    machineName: url.searchParams.get('machine_name') || existing.machineName || null,
    hostname: url.searchParams.get('hostname') || existing.hostname || null,
    capabilities: existing.capabilities || [],
    connectedAt: existing.connectedAt || new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
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
    // Electron desktop app / machine-agent
    const meta = buildProviderMeta(req, url);
    const machineId = meta.machineId || 'default';

    // If this machine already has a provider connection, replace it
    const existing = room.providers.get(machineId);
    if (existing && existing.ws.readyState === 1) {
      try { existing.ws.close(1000, 'Replaced by new provider connection'); } catch {}
    }

    room.providers.set(machineId, { ws, meta });
    console.log(`[tunnel] Provider connected: ${meta.machineName || machineId} for user ${userId} (${room.providers.size} total)`);

    // Auto-select if no active machine or this is the only one
    autoSelectActive(room);

    // Register machine as online in the database
    upsertMachine(userId, machineId, {
      machineName: meta.machineName,
      hostname: meta.hostname,
      capabilities: meta.capabilities,
      status: 'online',
    }).catch(err => console.warn('[tunnel] Failed to register machine:', err.message));

    // Notify all consumers about the new machine list
    notifyConsumers(room);

    ws.on('message', (data) => {
      const msg = typeof data === 'string' ? data : data.toString();

      // Capture provider metadata updates
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.t === 'provider-info') {
          const entry = room.providers.get(machineId);
          if (entry) {
            entry.meta = {
              ...entry.meta,
              capabilities: parsed.capabilities || entry.meta.capabilities || [],
              machineId: parsed.machineId || entry.meta.machineId || machineId,
              machineName: parsed.machineName || entry.meta.machineName || null,
              hostname: parsed.hostname || entry.meta.hostname || null,
              lastSeenAt: new Date().toISOString(),
            };
          }
        }
      } catch {
        // Ignore non-JSON messages
      }

      // Forward provider messages to all consumers
      for (const consumer of room.consumers) {
        if (consumer.readyState === 1) {
          try { consumer.send(msg); } catch {}
        }
      }
    });

    ws.on('close', () => {
      const entry = room.providers.get(machineId);
      if (entry && entry.ws === ws) {
        room.providers.delete(machineId);
        console.log(`[tunnel] Provider disconnected: ${machineId} for user ${userId} (${room.providers.size} remaining)`);

        // Auto-select another provider if this was the active one
        if (room.activeMachineId === machineId) {
          room.activeMachineId = null;
          autoSelectActive(room);
        }

        // Notify consumers
        if (room.providers.size === 0) {
          const gone = JSON.stringify({ t: 'provider-gone' });
          for (const consumer of room.consumers) {
            try { consumer.send(gone); } catch {}
          }
        } else {
          notifyConsumers(room);
        }

        // Mark machine offline in database
        setMachineOffline(userId, machineId)
          .catch(err => console.warn('[tunnel] Failed to set machine offline:', err.message));
      }
    });
  } else {
    // Web editor (consumer)
    room.consumers.add(ws);
    console.log(`[tunnel] Consumer connected for user ${userId} (${room.consumers.size} total)`);

    // Tell consumer about all available machines
    const active = getActiveProvider(room);
    const status = JSON.stringify({
      t: 'provider-status',
      available: !!active,
      provider: active?.meta || null,
      activeMachineId: room.activeMachineId,
      machines: buildMachineList(room),
    });
    ws.send(status);

    ws.on('message', (data) => {
      // Forward consumer messages to the ACTIVE provider only
      const activeEntry = getActiveProvider(room);
      if (activeEntry) {
        const msg = typeof data === 'string' ? data : data.toString();
        try { activeEntry.ws.send(msg); } catch {}
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
 * Handle tunnel HTTP API.
 *
 * GET  /api/tunnel/<userId>             — tunnel status + machine list
 * GET  /api/tunnel/<userId>/machines    — list connected machines
 * GET  /api/tunnel/<userId>/active      — get active machine
 * POST /api/tunnel/<userId>/active      — set active machine (body: {machineId})
 */
async function handleTunnelApiRequest(req, res, url) {
  // ── GET /api/tunnel/<userId> — overall status
  const statusMatch = url.pathname.match(/^\/api\/tunnel\/([^/]+)$/);
  if (statusMatch && req.method === 'GET') {
    const userId = decodeURIComponent(statusMatch[1]);
    const authedUserId = await authenticateHttpRequest(req);
    if (!authedUserId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    const room = tunnelRooms.get(userId);
    const active = room ? getActiveProvider(room) : null;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      available: !!active,
      consumers: room?.consumers.size || 0,
      activeMachineId: room?.activeMachineId || null,
      provider: active?.meta || null,
      machines: room ? buildMachineList(room) : [],
    }));
    return true;
  }

  // ── GET /api/tunnel/<userId>/machines — list connected machines
  const machinesMatch = url.pathname.match(/^\/api\/tunnel\/([^/]+)\/machines$/);
  if (machinesMatch && req.method === 'GET') {
    const userId = decodeURIComponent(machinesMatch[1]);
    const authedUserId = await authenticateHttpRequest(req);
    if (!authedUserId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    const room = tunnelRooms.get(userId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      activeMachineId: room?.activeMachineId || null,
      machines: room ? buildMachineList(room) : [],
    }));
    return true;
  }

  // ── GET /api/tunnel/<userId>/active — get active machine
  const activeGetMatch = url.pathname.match(/^\/api\/tunnel\/([^/]+)\/active$/);
  if (activeGetMatch && req.method === 'GET') {
    const userId = decodeURIComponent(activeGetMatch[1]);
    const authedUserId = await authenticateHttpRequest(req);
    if (!authedUserId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    const room = tunnelRooms.get(userId);
    const active = room ? getActiveProvider(room) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      activeMachineId: room?.activeMachineId || null,
      provider: active?.meta || null,
    }));
    return true;
  }

  // ── POST /api/tunnel/<userId>/active — set active machine
  const activePostMatch = url.pathname.match(/^\/api\/tunnel\/([^/]+)\/active$/);
  if (activePostMatch && req.method === 'POST') {
    const userId = decodeURIComponent(activePostMatch[1]);
    const authedUserId = await authenticateHttpRequest(req);
    if (!authedUserId) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return true;
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    let payload;
    try { payload = JSON.parse(body); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }

    const { machineId } = payload;
    const room = getTunnelRoom(userId);

    if (machineId) {
      const entry = room.providers.get(machineId);
      if (!entry || entry.ws.readyState !== 1) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Machine not connected', machineId }));
        return true;
      }
      room.activeMachineId = machineId;
    } else {
      // null = auto-select
      room.activeMachineId = null;
      autoSelectActive(room);
    }

    // Notify all consumers about the change
    notifyConsumers(room);

    const active = getActiveProvider(room);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      activeMachineId: room.activeMachineId,
      provider: active?.meta || null,
    }));
    return true;
  }

  return false;
}

// ─── Start ──────────────────────────────────────────────────────────────────

async function start() {
  console.log('[sync-relay] Starting...');

  // Initialize DB schema
  await initSchema();

  // Create Postgres storage backend
  const storage = createPostgresStorage({ pool });

  // Start mrmd-sync with Postgres storage + custom HTTP handler + tunnel
  // ── Bridge-on-demand: when a consumer opens a doc, tell the provider to bridge it ──
  // Rate-limit: don't send duplicate bridge-requests within 60 seconds.
  const bridgeRequestedRecently = new Map(); // key → expiry timestamp
  const BRIDGE_REQUEST_TTL_MS = 60000;

  function maybeRequestBridge(urlPath) {
    // Parse: /sync/<userId>/<project>/<docPath...>
    const stripped = urlPath.replace(/^\/sync\/?/, '');
    const parts = stripped.split('/');
    if (parts.length < 3) return;

    const userId = decodeURIComponent(parts[0]);
    const project = decodeURIComponent(parts[1]);
    const docPath = parts.slice(2).map(decodeURIComponent).join('/');

    // Remove query string from last segment
    const cleanDocPath = docPath.split('?')[0];
    if (!userId || !project || !cleanDocPath) return;

    const key = `${userId}/${project}/${cleanDocPath}`;
    const now = Date.now();

    // Rate-limit
    const expiry = bridgeRequestedRecently.get(key);
    if (expiry && expiry > now) return;
    bridgeRequestedRecently.set(key, now + BRIDGE_REQUEST_TTL_MS);

    // Periodic cleanup of expired entries
    if (bridgeRequestedRecently.size > 1000) {
      for (const [k, v] of bridgeRequestedRecently) {
        if (v < now) bridgeRequestedRecently.delete(k);
      }
    }

    // Find a provider for this user that can bridge this doc
    const room = tunnelRooms.get(userId);
    if (!room || room.providers.size === 0) return;

    // Send bridge-request to ALL connected providers
    // (the one that has the doc will bridge it; others will ignore)
    const bridgeMsg = JSON.stringify({
      t: 'bridge-request',
      project,
      docPath: cleanDocPath,
    });
    for (const [, entry] of room.providers) {
      if (entry.ws.readyState === 1) {
        try { entry.ws.send(bridgeMsg); } catch {}
      }
    }
  }

  const server = createServer({
    dir: '/tmp/sync-relay-noop',
    port: PORT,
    auth: authHandler,
    storage,
    pathPrefix: '/sync',
    onRequest: async (req, res, url) => {
      // Try tunnel API first
      if (await handleTunnelApiRequest(req, res, url)) return true;
      // Then catalog/machine API
      if (await handleCatalogApiRequest(req, res, url)) return true;
      // Then document API
      return handleApiRequest(req, res, url);
    },
    onConnection: async (ws, req) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/tunnel/')) {
        handleTunnelConnection(ws, req);
        return true; // Handled — don't pass to Yjs handler
      }
      // For sync connections: request on-demand bridging from the provider
      if (url.pathname.startsWith('/sync/')) {
        maybeRequestBridge(url.pathname);
      }
      return false;
    },
    debounceMs: 2000,
    maxConnections: 2000,
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
  console.log(`[sync-relay] Catalog: http://localhost:${PORT}/api/catalog/<userId>[/<machineId>]`);
  console.log(`[sync-relay] Machines: http://localhost:${PORT}/api/machines/<userId>`);
}

start().catch(err => {
  console.error('[sync-relay] Fatal:', err);
  process.exit(1);
});
