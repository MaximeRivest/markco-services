/**
 * Sync Relay — persistent Yjs sync service for markco.dev
 *
 * Manages Yjs documents in memory with Postgres persistence.
 * Accepts authenticated WebSocket connections for real-time sync.
 * Documents survive container/editor restarts.
 *
 * WebSocket path: /sync/:userId/:project/:docPath
 * HTTP endpoints: /health, /stats, /api/documents/:userId, /api/documents/:userId/:project
 */

import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { initSchema, healthCheck as dbHealthCheck } from './db.js';
import { loadDocument, saveDocument, listUserDocuments, listProjectDocuments } from './yjs-store.js';

const PORT = parseInt(process.env.SYNC_RELAY_PORT || process.env.PORT || '3006', 10);
const SAVE_DEBOUNCE_MS = parseInt(process.env.SAVE_DEBOUNCE_MS || '2000', 10);
const DOC_CLEANUP_DELAY_MS = parseInt(process.env.DOC_CLEANUP_DELAY_MS || '60000', 10);
const PING_INTERVAL_MS = 30000;
const MAX_CONNECTIONS = 200;

// Yjs message types
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

// ─── Metrics ────────────────────────────────────────────────────────────────

const metrics = {
  connectionsOpened: 0,
  connectionsClosed: 0,
  activeConnections: 0,
  messagesReceived: 0,
  messagesSent: 0,
  documentsLoaded: 0,
  documentsSaved: 0,
  saveErrors: 0,
  errors: 0,
  startedAt: new Date().toISOString(),
};

// ─── Document Store (in-memory with Postgres backing) ───────────────────────

/** Map of "userId/project/docPath" → DocEntry */
const docs = new Map();

/**
 * @typedef {Object} DocEntry
 * @property {string} key
 * @property {string} userId
 * @property {string} project
 * @property {string} docPath
 * @property {Y.Doc} ydoc
 * @property {Y.Text} ytext
 * @property {awarenessProtocol.Awareness} awareness
 * @property {Set<import('ws').WebSocket>} conns
 * @property {NodeJS.Timeout|null} saveTimeout
 * @property {NodeJS.Timeout|null} cleanupTimeout
 * @property {boolean} dirty
 */

function docKey(userId, project, docPath) {
  return `${userId}/${project}/${docPath}`;
}

/**
 * Get or create a document, loading from Postgres if needed.
 */
async function getDoc(userId, project, docPath) {
  const key = docKey(userId, project, docPath);

  if (docs.has(key)) {
    const entry = docs.get(key);
    // Cancel cleanup if it was scheduled
    if (entry.cleanupTimeout) {
      clearTimeout(entry.cleanupTimeout);
      entry.cleanupTimeout = null;
    }
    return entry;
  }

  // Create new Y.Doc and try to load from Postgres
  const ydoc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(ydoc);
  const ytext = ydoc.getText('content');

  try {
    const { yjsState } = await loadDocument(userId, project, docPath);
    if (yjsState && yjsState.byteLength > 0) {
      Y.applyUpdate(ydoc, yjsState);
      console.log(`[sync-relay] Loaded doc from DB: ${key} (${yjsState.byteLength} bytes)`);
    }
    metrics.documentsLoaded++;
  } catch (err) {
    console.error(`[sync-relay] Error loading doc ${key}:`, err.message);
    metrics.errors++;
  }

  const entry = {
    key,
    userId,
    project,
    docPath,
    ydoc,
    ytext,
    awareness,
    conns: new Set(),
    saveTimeout: null,
    cleanupTimeout: null,
    dirty: false,
  };

  // Schedule save on any update
  ydoc.on('update', () => {
    entry.dirty = true;
    scheduleSave(entry);
  });

  docs.set(key, entry);
  return entry;
}

/**
 * Debounced save to Postgres.
 */
function scheduleSave(entry) {
  if (entry.saveTimeout) return; // already scheduled

  entry.saveTimeout = setTimeout(async () => {
    entry.saveTimeout = null;
    if (!entry.dirty) return;

    try {
      const yjsState = Y.encodeStateAsUpdate(entry.ydoc);
      const text = entry.ytext.toString();
      await saveDocument(entry.userId, entry.project, entry.docPath, yjsState, text);
      entry.dirty = false;
      metrics.documentsSaved++;
    } catch (err) {
      console.error(`[sync-relay] Save error for ${entry.key}:`, err.message);
      metrics.saveErrors++;
      metrics.errors++;
      // Retry on next update
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Immediately flush a document to Postgres.
 */
async function flushDoc(entry) {
  if (entry.saveTimeout) {
    clearTimeout(entry.saveTimeout);
    entry.saveTimeout = null;
  }

  if (!entry.dirty) return;

  try {
    const yjsState = Y.encodeStateAsUpdate(entry.ydoc);
    const text = entry.ytext.toString();
    await saveDocument(entry.userId, entry.project, entry.docPath, yjsState, text);
    entry.dirty = false;
    metrics.documentsSaved++;
  } catch (err) {
    console.error(`[sync-relay] Flush error for ${entry.key}:`, err.message);
    metrics.saveErrors++;
    metrics.errors++;
  }
}

/**
 * Schedule cleanup for a document after all clients disconnect.
 */
function scheduleCleanup(entry) {
  if (entry.cleanupTimeout) return;

  entry.cleanupTimeout = setTimeout(async () => {
    if (entry.conns.size > 0) return; // someone reconnected

    // Flush to DB, then destroy
    await flushDoc(entry);
    entry.awareness.destroy();
    entry.ydoc.destroy();
    docs.delete(entry.key);
    console.log(`[sync-relay] Cleaned up doc: ${entry.key}`);
  }, DOC_CLEANUP_DELAY_MS);
}

// ─── WebSocket Helpers ──────────────────────────────────────────────────────

function safeSend(ws, data) {
  try {
    if (ws.readyState === 1) { // OPEN
      ws.send(data, { binary: true });
      metrics.messagesSent++;
    }
  } catch {
    // Ignore send errors on closing connections
  }
}

// ─── Express App (HTTP endpoints) ───────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', async (_req, res) => {
  try {
    await dbHealthCheck();
    res.json({ status: 'ok', service: 'sync-relay' });
  } catch (err) {
    res.status(503).json({ status: 'unhealthy', error: err.message });
  }
});

app.get('/stats', (_req, res) => {
  res.json({
    ...metrics,
    documentsInMemory: docs.size,
    documents: Array.from(docs.values()).map(d => ({
      key: d.key,
      connections: d.conns.size,
      dirty: d.dirty,
      contentLength: d.ytext.toString().length,
    })),
  });
});

// List documents for a user
app.get('/api/documents/:userId', async (req, res) => {
  try {
    const rows = await listUserDocuments(req.params.userId);
    res.json(rows);
  } catch (err) {
    console.error('[sync-relay] List docs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// List documents in a project
app.get('/api/documents/:userId/:project', async (req, res) => {
  try {
    const rows = await listProjectDocuments(req.params.userId, req.params.project);
    res.json(rows);
  } catch (err) {
    console.error('[sync-relay] List project docs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HTTP + WebSocket Server ────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

/**
 * Parse the sync WebSocket URL.
 * Expected: /sync/:userId/:project/:docPath(+)
 * docPath can contain slashes for nested docs (e.g. 02-analysis/01-data)
 */
function parseSyncUrl(pathname) {
  // Remove leading /sync/
  const match = pathname.match(/^\/sync\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return {
    userId: match[1],
    project: match[2],
    docPath: match[3],
  };
}

server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const parsed = parseSyncUrl(url.pathname);

  if (!parsed) {
    socket.destroy();
    return;
  }

  const { userId, project, docPath } = parsed;

  // Auth: check X-User-Id header (set by orchestrator proxy) or token query param
  const headerUserId = req.headers['x-user-id'];
  const tokenParam = url.searchParams.get('token');

  // In proxy mode (from orchestrator), trust X-User-Id header
  // The orchestrator has already validated the session cookie
  if (headerUserId && headerUserId !== userId) {
    console.warn(`[sync-relay] Auth mismatch: header=${headerUserId}, url=${userId}`);
    socket.destroy();
    return;
  }

  // If no X-User-Id and no token, reject (unless auth is disabled for dev)
  if (!headerUserId && !tokenParam && process.env.SYNC_RELAY_NO_AUTH !== '1') {
    socket.destroy();
    return;
  }

  // Rate limit: max connections
  if (metrics.activeConnections >= MAX_CONNECTIONS) {
    console.warn('[sync-relay] Max connections reached, rejecting');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, async (ws) => {
    try {
      await handleConnection(ws, userId, project, docPath);
    } catch (err) {
      console.error(`[sync-relay] Connection setup error for ${userId}/${project}/${docPath}:`, err.message);
      ws.close(1011, 'Internal error');
    }
  });
});

/**
 * Handle a new WebSocket connection for a document.
 */
async function handleConnection(ws, userId, project, docPath) {
  const entry = await getDoc(userId, project, docPath);
  const { ydoc, awareness, conns } = entry;

  metrics.connectionsOpened++;
  metrics.activeConnections++;
  conns.add(ws);

  console.log(`[sync-relay] Client connected: ${entry.key} (${conns.size} clients)`);

  // Heartbeat
  let isAlive = true;
  ws.on('pong', () => { isAlive = true; });
  const pingInterval = setInterval(() => {
    if (!isAlive) {
      ws.terminate();
      return;
    }
    isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }, PING_INTERVAL_MS);

  // Send sync step 1
  const syncEncoder = encoding.createEncoder();
  encoding.writeVarUint(syncEncoder, MSG_SYNC);
  syncProtocol.writeSyncStep1(syncEncoder, ydoc);
  safeSend(ws, encoding.toUint8Array(syncEncoder));

  // Send current awareness states
  const awarenessStates = awareness.getStates();
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, Array.from(awarenessStates.keys()))
    );
    safeSend(ws, encoding.toUint8Array(awarenessEncoder));
  }

  // Message handler
  ws.on('message', (rawMessage) => {
    try {
      const data = new Uint8Array(rawMessage);
      metrics.messagesReceived++;

      const decoder = decoding.createDecoder(data);
      const msgType = decoding.readVarUint(decoder);

      switch (msgType) {
        case MSG_SYNC: {
          const responseEncoder = encoding.createEncoder();
          encoding.writeVarUint(responseEncoder, MSG_SYNC);
          syncProtocol.readSyncMessage(decoder, responseEncoder, ydoc, ws);
          if (encoding.length(responseEncoder) > 1) {
            safeSend(ws, encoding.toUint8Array(responseEncoder));
          }
          break;
        }
        case MSG_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            decoding.readVarUint8Array(decoder),
            ws
          );
          break;
        }
      }
    } catch (err) {
      console.error(`[sync-relay] Message error for ${entry.key}:`, err.message);
      metrics.errors++;
    }
  });

  // Broadcast updates to other clients
  const updateHandler = (update, origin) => {
    const broadcastEncoder = encoding.createEncoder();
    encoding.writeVarUint(broadcastEncoder, MSG_SYNC);
    syncProtocol.writeUpdate(broadcastEncoder, update);
    const msg = encoding.toUint8Array(broadcastEncoder);

    for (const conn of conns) {
      if (conn !== origin) {
        safeSend(conn, msg);
      }
    }
  };
  ydoc.on('update', updateHandler);

  // Broadcast awareness changes
  const awarenessHandler = ({ added, updated, removed }) => {
    const changedClients = [...added, ...updated, ...removed];
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      awarenessEncoder,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients)
    );
    const msg = encoding.toUint8Array(awarenessEncoder);
    for (const conn of conns) {
      safeSend(conn, msg);
    }
  };
  awareness.on('update', awarenessHandler);

  // Cleanup on close
  ws.on('close', () => {
    clearInterval(pingInterval);
    metrics.connectionsClosed++;
    metrics.activeConnections--;
    conns.delete(ws);
    ydoc.off('update', updateHandler);
    awareness.off('update', awarenessHandler);
    awarenessProtocol.removeAwarenessStates(awareness, [ydoc.clientID], null);

    console.log(`[sync-relay] Client disconnected: ${entry.key} (${conns.size} clients)`);

    if (conns.size === 0) {
      scheduleCleanup(entry);
    }
  });

  ws.on('error', (err) => {
    console.error(`[sync-relay] WS error for ${entry.key}:`, err.message);
    metrics.errors++;
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[sync-relay] ${signal} received, shutting down...`);

  // Close all WebSocket connections
  for (const entry of docs.values()) {
    for (const ws of entry.conns) {
      try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
    }
  }

  // Flush all dirty documents to Postgres
  console.log(`[sync-relay] Flushing ${docs.size} documents...`);
  const flushPromises = Array.from(docs.values()).map(entry => flushDoc(entry));
  await Promise.allSettled(flushPromises);

  // Destroy all Y.Docs
  for (const entry of docs.values()) {
    entry.awareness.destroy();
    entry.ydoc.destroy();
  }
  docs.clear();

  // Close server
  server.close();
  console.log('[sync-relay] Shutdown complete');
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ──────────────────────────────────────────────────────────────────

async function start() {
  console.log('[sync-relay] Starting...');

  // Initialize DB schema
  await initSchema();

  server.listen(PORT, () => {
    console.log(`[sync-relay] Listening on :${PORT}`);
    console.log(`[sync-relay] WebSocket: ws://localhost:${PORT}/sync/:userId/:project/:docPath`);
    console.log(`[sync-relay] Health: http://localhost:${PORT}/health`);
  });
}

start().catch(err => {
  console.error('[sync-relay] Fatal:', err);
  process.exit(1);
});
