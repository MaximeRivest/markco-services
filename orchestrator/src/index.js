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
      // Phase 0: log concisely instead of full stack trace
      if (err.code !== 'ECONNREFUSED') {
        console.warn(`[ws-proxy] Upstream error (${targetUrl}): ${err.code || err.message}`);
      } else {
        console.error(`[ws-proxy] Upstream refused: ${targetUrl}`);
      }
      if (!clientClosed) {
        try { clientWs.close(); } catch { /* ignore */ }
      }
    });

    return upstream;
  }

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/u\/([^/]+)(\/.*)?$/);
    if (!match) {
      socket.destroy();
      return;
    }

    const [, userId, rest = '/'] = match;

    // Authenticate via cookie
    const cookies = {};
    (req.headers.cookie || '').split(';').forEach(c => {
      const [k, v] = c.trim().split('=');
      if (k) cookies[k] = v;
    });
    const token = cookies.session_token || url.searchParams.get('token');
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
        const editor = getEditorInfo(userId);
        if (!editor) { socket.destroy(); return; }

        const editorUrl = `ws://localhost:${editor.editorPort}${rest}${url.search}`;
        const relayUrl = `ws://localhost:${SYNC_RELAY_PORT}/sync/${userId}/${project}/${docPath}`;

        wss.handleUpgrade(req, socket, head, (clientWs) => {
          // Primary: proxy to editor as usual
          const upstream = createWsProxy(clientWs, editorUrl);

          // Mirror: open a parallel connection to the relay to persist state
          // The relay connection receives all updates but doesn't send back to client
          const mirror = new WebSocket(relayUrl, {
            headers: { 'X-User-Id': userId },
          });

          // Forward Yjs updates to mirror (binary messages only)
          upstream.on('message', (data, isBinary) => {
            if (isBinary && mirror.readyState === WebSocket.OPEN) {
              try { mirror.send(data, { binary: true }); } catch { /* ignore */ }
            }
          });

          // Also forward client messages to mirror
          clientWs.on('message', (data, isBinary) => {
            if (isBinary && mirror.readyState === WebSocket.OPEN) {
              try { mirror.send(data, { binary: true }); } catch { /* ignore */ }
            }
          });

          // Clean up mirror on close
          clientWs.on('close', () => {
            try { mirror.close(); } catch { /* ignore */ }
          });
          mirror.on('error', (err) => {
            console.warn(`[ws-mirror] Relay mirror error: ${err.message}`);
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
