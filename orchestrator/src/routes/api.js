/**
 * Internal API routes for health checks and service status.
 */

import { Router } from 'express';
import { authService, publishService, syncRelay } from '../service-client.js';
import { healthCheck as caddyHealth } from '../caddy.js';

const router = Router();

// ── GET /api/health ───────────────────────────────────────────────────
router.get('/api/health', async (_req, res) => {
  const checks = await Promise.allSettled([
    authService.health(),
    publishService.health(),
    caddyHealth(),
    syncRelay.health(),
  ]);

  const services = {
    orchestrator: 'ok',
    auth: checks[0].status === 'fulfilled' ? 'ok' : 'down',
    publish: checks[1].status === 'fulfilled' ? 'ok' : 'down',
    caddy: checks[2].status === 'fulfilled' && checks[2].value ? 'ok' : 'down',
    'sync-relay': checks[3].status === 'fulfilled' ? 'ok' : 'down',
  };

  const allOk = Object.values(services).every(s => s === 'ok');
  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    services,
    timestamp: new Date().toISOString(),
  });
});

// ── GET /api/services ─────────────────────────────────────────────────
router.get('/api/services', async (_req, res) => {
  const [auth, publish, caddy, relay] = await Promise.allSettled([
    authService.health(),
    publishService.health(),
    caddyHealth(),
    syncRelay.health(),
  ]);

  res.json({
    services: {
      auth: {
        url: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
        status: auth.status === 'fulfilled' ? auth.value : { status: 'down' },
      },
      publish: {
        url: process.env.PUBLISH_SERVICE_URL || 'http://localhost:3003',
        status: publish.status === 'fulfilled' ? publish.value : { status: 'down' },
      },
      caddy: {
        url: process.env.CADDY_ADMIN_URL || 'http://localhost:2019',
        status: caddy.status === 'fulfilled' && caddy.value ? 'ok' : 'down',
      },
      'sync-relay': {
        url: process.env.SYNC_RELAY_URL || `http://localhost:${process.env.SYNC_RELAY_PORT || '3006'}`,
        status: relay.status === 'fulfilled' ? relay.value : { status: 'down' },
      },
    },
    timestamp: new Date().toISOString(),
  });
});

export default router;
