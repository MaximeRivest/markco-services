/**
 * markco.dev orchestrator — the single entry point for the platform.
 *
 * Starts all Layer 3 services, configures Caddy, registers webhooks,
 * and serves as the main HTTP server on port 3000.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocket } from 'ws';
import { startAll, stopAll } from './process-manager.js';
import { resourceMonitor, authService } from './service-client.js';
import { loadConfig, healthCheck as caddyHealthCheck } from './caddy.js';
import { generateCaddyConfig } from './caddy-config.js';
import { getEditorInfo, reconcileContainers, startHealthChecks } from './user-lifecycle.js';
import mainRoutes from './routes/main.js';
import apiRoutes from './routes/api.js';
import eventHandler from './event-handler.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const app = express();

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));
app.use(cookieParser());

// Trust proxy (behind Caddy)
app.set('trust proxy', 1);

// Health check (for Caddy / load balancers)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'orchestrator' });
});

// Mount routes
app.use(eventHandler);
app.use(apiRoutes);
app.use(mainRoutes);

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[orchestrator] Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  console.log('[orchestrator] Starting markco.dev platform...');

  // 1. Start all Layer 3 services
  await startAll();

  // 2. Register webhook with resource-monitor so events flow to us
  try {
    const webhookUrl = `http://localhost:${PORT}/hooks/resource`;
    await resourceMonitor.registerWebhook(webhookUrl);
    console.log(`[orchestrator] Webhook registered: ${webhookUrl}`);
  } catch (err) {
    console.warn(`[orchestrator] Failed to register webhook: ${err.message}`);
  }

  // 3. Start HTTP server
  const server = app.listen(PORT, () => {
    console.log(`[orchestrator] Listening on :${PORT}`);
  });

  // WebSocket proxy for editor containers (/u/{userId}/events, /u/{userId}/sync/...)
  // and sync-relay routing when SYNC_MODE is mirror or relay_primary
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ noServer: true });

  const SYNC_MODE = process.env.SYNC_MODE || 'legacy';
  const SYNC_RELAY_PORT = parseInt(process.env.SYNC_RELAY_PORT || '3006', 10);
  console.log(`[orchestrator] SYNC_MODE=${SYNC_MODE}, relay port=${SYNC_RELAY_PORT}`);

  // Throttle repeated upstream WS errors (stale sync ports can reconnect rapidly).
  const WS_ERROR_LOG_WINDOW_MS = 15000;
  const wsErrorLogState = new Map();

  function pruneWsErrorLogState() {
    if (wsErrorLogState.size < 300) return;
    const cutoff = Date.now() - (WS_ERROR_LOG_WINDOW_MS * 4);
    for (const [key, value] of wsErrorLogState.entries()) {
      if (value.lastAt < cutoff) wsErrorLogState.delete(key);
    }
  }

  function logWsProxyError(targetUrl, err, level = 'warn') {
    const code = err?.code || err?.message || 'unknown';
    const key = `${targetUrl}|${code}`;
    const now = Date.now();
    const prev = wsErrorLogState.get(key);

    if (!prev || (now - prev.lastAt) > WS_ERROR_LOG_WINDOW_MS) {
      const suppressed = prev?.suppressed || 0;
      const suffix = suppressed > 0 ? ` (suppressed ${suppressed} repeats)` : '';
      if (level === 'error') {
        console.error(`[ws-proxy] Upstream error (${targetUrl}): ${code}${suffix}`);
      } else {
        console.warn(`[ws-proxy] Upstream error (${targetUrl}): ${code}${suffix}`);
      }
      wsErrorLogState.set(key, { lastAt: now, suppressed: 0 });
      pruneWsErrorLogState();
      return;
    }

    prev.suppressed += 1;
    wsErrorLogState.set(key, prev);
    pruneWsErrorLogState();
  }

  /**
   * Create a bidirectional WebSocket proxy with buffering and error handling.
   * Phase 0 improvement: proper error handling to prevent "socket hang up" spam.
   */
  function createWsProxy(clientWs, targetUrl, opts = {}) {
    const { headers = {} } = opts;
    const upstream = new WebSocket(targetUrl, { headers });
    const buffered = [];
    let upstreamOpen = false;
    let clientClosed = false;
    let upstreamClosed = false;

    clientWs.on('message', (data, isBinary) => {
      if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
        try { upstream.send(data, { binary: isBinary }); } catch { /* closing */ }
      } else if (!upstreamClosed) {
        buffered.push({ data, isBinary });
      }
    });

    upstream.on('open', () => {
      upstreamOpen = true;
      for (const msg of buffered) {
        try { upstream.send(msg.data, { binary: msg.isBinary }); } catch { /* closing */ }
      }
      buffered.length = 0;
    });

    upstream.on('message', (data, isBinary) => {
      if (!clientClosed && clientWs.readyState === 1) {
        try { clientWs.send(data, { binary: isBinary }); } catch { /* closing */ }
      }
    });

    clientWs.on('close', () => {
      clientClosed = true;
      if (!upstreamClosed) {
        try { upstream.close(); } catch { /* ignore */ }
      }
    });

    upstream.on('close', () => {
      upstreamClosed = true;
      if (!clientClosed) {
        try { clientWs.close(); } catch { /* ignore */ }
      }
    });

    clientWs.on('error', (err) => {
      if (!upstreamClosed) {
        try { upstream.close(); } catch { /* ignore */ }
      }
    });

    upstream.on('error', (err) => {
      // Phase 0 + follow-up: concise + throttled logging to avoid reconnect noise.
      if (err.code === 'ECONNREFUSED') {
        logWsProxyError(targetUrl, { code: 'ECONNREFUSED' }, 'error');
      } else {
        logWsProxyError(targetUrl, err, 'warn');
      }
      if (!clientClosed) {
        try { clientWs.close(); } catch { /* ignore */ }
      }
    });

    return upstream;
  }

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');

    // Authenticate via cookie/query/bearer token
    const cookies = {};
    (req.headers.cookie || '').split(';').forEach(c => {
      const [k, v] = c.trim().split('=');
      if (k) cookies[k] = v;
    });
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : null;
    const token = cookies.session_token || url.searchParams.get('token') || bearerToken;

    // ── Direct relay path for desktop/mobile clients ─────────────────────
    // Path: /sync/:userId/:project/:docPath
    // This avoids going through /u/:userId/... and editor container routing.
    const directSyncMatch = url.pathname.match(/^\/sync\/([^/]+)\/([^/]+)\/(.+)$/);
    if (directSyncMatch) {
      if (!token) { socket.destroy(); return; }

      const [, userIdRaw] = directSyncMatch;
      const userId = decodeURIComponent(userIdRaw);

      let validatedUser;
      try {
        validatedUser = await authService.validate(token);
      } catch {
        socket.destroy();
        return;
      }

      const validatedUserId = validatedUser?.user?.id;
      if (!validatedUserId || validatedUserId !== userId) {
        socket.destroy();
        return;
      }

      const relayUrl = `ws://localhost:${SYNC_RELAY_PORT}${url.pathname}${url.search}`;
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        createWsProxy(clientWs, relayUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
            'X-User-Id': userId,
          },
        });
      });
      return;
    }

    // ── Runtime tunnel path for desktop → relay → editor ─────────────────
    // Path: /tunnel/:userId?role=provider|consumer
    const tunnelMatch = url.pathname.match(/^\/tunnel\/([^/]+)$/);
    if (tunnelMatch) {
      if (!token) { socket.destroy(); return; }

      const userId = decodeURIComponent(tunnelMatch[1]);
      let validatedUser;
      try {
        validatedUser = await authService.validate(token);
      } catch {
        socket.destroy();
        return;
      }

      const validatedUserId = validatedUser?.user?.id;
      if (!validatedUserId || validatedUserId !== userId) {
        socket.destroy();
        return;
      }

      const tunnelUrl = `ws://localhost:${SYNC_RELAY_PORT}/tunnel/${encodeURIComponent(userId)}${url.search}`;
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        createWsProxy(clientWs, tunnelUrl, {
          headers: {
            'X-User-Id': userId,
          },
        });
      });
      return;
    }

    const match = url.pathname.match(/^\/u\/([^/]+)(\/.*)?$/);
    if (!match) {
      socket.destroy();
      return;
    }

    const [, userId, rest = '/'] = match;

    if (!token) { socket.destroy(); return; }

    let validatedUser;
    try {
      validatedUser = await authService.validate(token);
    } catch { socket.destroy(); return; }

    // ── Sync relay routing ──────────────────────────────────────────────
    // Match sync paths: /u/:userId/sync/:port/:docPath  (legacy format)
    // In relay_primary mode, route to sync-relay instead of editor container.
    const syncMatch = rest?.match(/^\/sync\/(\d+)\/(.+)$/);

    if (syncMatch && (SYNC_MODE === 'relay_primary' || SYNC_MODE === 'mirror')) {
      const [, legacySyncPort, docPathRaw] = syncMatch;

      // For relay routing, we need to map the legacy URL format to relay format.
      // Legacy: /sync/:port/:docPath → Relay: /sync/:userId/:project/:docPath
      // We extract project from the editor context (for now, use "default" as fallback).
      // The editor container sends the project name as part of the doc path.
      // TODO: once the editor sends project info, parse it here.
      const project = 'default';
      const docPath = docPathRaw;

      if (SYNC_MODE === 'relay_primary') {
        // Route directly to sync relay
        const relayUrl = `ws://localhost:${SYNC_RELAY_PORT}/sync/${userId}/${project}/${docPath}`;

        wss.handleUpgrade(req, socket, head, (clientWs) => {
          createWsProxy(clientWs, relayUrl, {
            headers: { 'X-User-Id': userId },
          });
        });
        return;
      }

      if (SYNC_MODE === 'mirror') {
        // Primary path: editor container (legacy)
        // Secondary: also mirror to sync relay for durability
        // IMPORTANT: only open mirror AFTER upstream connects successfully
        // to prevent reconnect storms when the editor's internal sync port is stale
        const editor = getEditorInfo(userId);
        if (!editor) { socket.destroy(); return; }

        const editorUrl = `ws://localhost:${editor.editorPort}${rest}${url.search}`;
        const relayUrl = `ws://localhost:${SYNC_RELAY_PORT}/sync/${userId}/${project}/${docPath}`;

        wss.handleUpgrade(req, socket, head, (clientWs) => {
          // Primary: proxy to editor as usual
          const upstream = createWsProxy(clientWs, editorUrl);

          // Mirror: only open after upstream is connected
          let mirror = null;

          upstream.on('open', () => {
            // Now safe to open the mirror — upstream is alive
            mirror = new WebSocket(relayUrl, {
              headers: { 'X-User-Id': userId },
            });

            mirror.on('error', (err) => {
              // Mirror errors are non-fatal — primary sync still works
              if (err.code !== 'ECONNREFUSED') {
                console.warn(`[ws-mirror] Relay error: ${err.code || err.message}`);
              }
            });
          });

          // Forward Yjs updates to mirror (binary messages only)
          upstream.on('message', (data, isBinary) => {
            if (isBinary && mirror?.readyState === WebSocket.OPEN) {
              try { mirror.send(data, { binary: true }); } catch { /* ignore */ }
            }
          });

          // Also forward client messages to mirror
          clientWs.on('message', (data, isBinary) => {
            if (isBinary && mirror?.readyState === WebSocket.OPEN) {
              try { mirror.send(data, { binary: true }); } catch { /* ignore */ }
            }
          });

          // Clean up mirror on close
          clientWs.on('close', () => {
            if (mirror) try { mirror.close(); } catch { /* ignore */ }
          });
        });
        return;
      }
    }

    // ── Default: proxy to editor container ──────────────────────────────
    const editor = getEditorInfo(userId);
    if (!editor) { socket.destroy(); return; }

    const targetUrl = `ws://localhost:${editor.editorPort}${rest}${url.search}`;

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      createWsProxy(clientWs, targetUrl);
    });
  });

  // 4. Apply Caddy config (non-blocking, Caddy may not be running in dev)
  try {
    const caddyUp = await caddyHealthCheck();
    if (caddyUp) {
      await loadConfig(generateCaddyConfig());
    } else {
      console.warn('[orchestrator] Caddy not reachable, skipping config load');
    }
  } catch (err) {
    console.warn(`[orchestrator] Caddy config failed: ${err.message}`);
  }

  console.log('[orchestrator] Platform ready');

  // 5. Reconcile any running containers from before the restart
  try {
    await reconcileContainers();
  } catch (err) {
    console.warn(`[orchestrator] Container reconciliation failed: ${err.message}`);
  }

  // 6. Start periodic health checks for active containers
  startHealthChecks();

  // Graceful shutdown
  async function shutdown(signal) {
    console.log(`\n[orchestrator] ${signal} received, shutting down...`);
    server.close();
    await stopAll();
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[orchestrator] Fatal error:', err);
  process.exit(1);
});

export default app;
