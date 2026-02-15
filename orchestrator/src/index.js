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
  const { WebSocketServer } = await import('ws');
  const wss = new WebSocketServer({ noServer: true });

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

    try {
      await authService.validate(token);
    } catch { socket.destroy(); return; }

    const editor = getEditorInfo(userId);
    if (!editor) { socket.destroy(); return; }

    // Accept client WebSocket first, then connect upstream
    const targetUrl = `ws://localhost:${editor.editorPort}${rest}${url.search}`;

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const upstream = new WebSocket(targetUrl);
      const buffered = [];

      clientWs.on('message', (data, isBinary) => {
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        } else {
          buffered.push({ data, isBinary });
        }
      });

      upstream.on('open', () => {
        for (const msg of buffered) upstream.send(msg.data, { binary: msg.isBinary });
        buffered.length = 0;
      });

      upstream.on('message', (data, isBinary) => {
        if (clientWs.readyState === 1) clientWs.send(data, { binary: isBinary });
      });

      clientWs.on('close', () => upstream.close());
      upstream.on('close', () => clientWs.close());
      clientWs.on('error', () => upstream.close());
      upstream.on('error', (err) => {
        console.error(`[ws-proxy] Upstream error for ${targetUrl}: ${err.message}`);
        clientWs.close();
      });
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
