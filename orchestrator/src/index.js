/**
 * markco.dev orchestrator — the single entry point for the platform.
 *
 * Starts the core services, configures Caddy,
 * and serves as the main HTTP server on port 3000.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocket } from 'ws';
import { startAll, stopAll } from './process-manager.js';
import { authService } from './service-client.js';
import { loadConfig, healthCheck as caddyHealthCheck } from './caddy.js';
import { generateCaddyConfig } from './caddy-config.js';
import mainRoutes from './routes/main.js';
import apiRoutes from './routes/api.js';
import shareRoutes, { ensureTunnelClient, getShareAccessForToken } from './routes/shares.js';

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
app.use(apiRoutes);
app.use(shareRoutes);
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

  // 2. Start HTTP server
  const server = app.listen(PORT, () => {
    console.log(`[orchestrator] Listening on :${PORT}`);
  });

  // WebSocket handling for collaboration and tunnel proxying.
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ noServer: true });

  const SYNC_RELAY_PORT = parseInt(process.env.SYNC_RELAY_PORT || '3006', 10);
  console.log(`[orchestrator] relay port=${SYNC_RELAY_PORT}`);

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
  function encodePathSegments(value) {
    return String(value || '').split('/').map(encodeURIComponent).join('/');
  }

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

    // ── Direct collaboration path: browser → tunnel → owner's local sync ──
    // Path: /api/collab/:shareToken/sync/:docPath
    const collabSyncMatch = url.pathname.match(/^\/api\/collab\/([^/]+)\/sync\/(.+)$/);
    if (collabSyncMatch) {
      const [, shareToken, docPathRaw] = collabSyncMatch;
      try {
        const access = await getShareAccessForToken(shareToken, req, { joinIfNeeded: true });
        const { share } = access;
        const requestedDocPath = decodeURIComponent(docPathRaw || '');
        const expectedDocPath = String(share.docPath || '').replace(/^\/+/, '');
        if (!expectedDocPath || requestedDocPath !== expectedDocPath) {
          socket.destroy();
          return;
        }

        const tunnelClient = await ensureTunnelClient(share.owner.id);
        const available = await tunnelClient.waitForAvailability(5000);
        if (!available) {
          console.warn(`[collab-sync] Tunnel provider unavailable for ${share.owner.id}`);
          socket.destroy();
          return;
        }

        const sync = await tunnelClient.getSharedSyncInfo({
          sharedProject: share.project,
          sharedDocPath: expectedDocPath,
        });
        if (!sync?.syncPort) {
          console.warn(`[collab-sync] Missing sync port for ${share.owner.id} ${share.project}/${expectedDocPath}`);
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (clientWs) => {
          tunnelClient.wsProxy(sync.syncPort, encodePathSegments(expectedDocPath), clientWs);
        });
      } catch (err) {
        console.warn(`[collab-sync] upgrade failed: ${err?.message || err}`);
        socket.destroy();
      }
      return;
    }

    // ── Direct relay path for desktop/mobile/collaborator clients ────────
    // Path: /sync/:ownerId/:project/:docPath
    // The relay itself performs auth + share checks. We simply proxy through,
    // forwarding cookie/auth headers when present so same-origin browser
    // WebSockets work with session cookies.
    const directSyncMatch = url.pathname.match(/^\/sync\/([^/]+)\/([^/]+)\/(.+)$/);
    if (directSyncMatch) {
      const relayUrl = `ws://localhost:${SYNC_RELAY_PORT}${url.pathname}${url.search}`;
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        const headers = {};
        if (req.headers.authorization) headers.Authorization = req.headers.authorization;
        if (req.headers.cookie) headers.Cookie = req.headers.cookie;
        createWsProxy(clientWs, relayUrl, { headers });
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

    socket.destroy();
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
