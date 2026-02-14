/**
 * Internal API routes for health checks and service status.
 */

import { Router } from 'express';
import { authService, computeManager, resourceMonitor, publishService } from '../service-client.js';
import { healthCheck as caddyHealth } from '../caddy.js';
import { getAllEditors } from '../user-lifecycle.js';

const router = Router();

// ── GET /api/health ───────────────────────────────────────────────────
router.get('/api/health', async (_req, res) => {
  const checks = await Promise.allSettled([
    authService.health(),
    computeManager.health(),
    resourceMonitor.health(),
    caddyHealth(),
  ]);

  const services = {
    orchestrator: 'ok',
    auth: checks[0].status === 'fulfilled' ? 'ok' : 'down',
    compute: checks[1].status === 'fulfilled' ? 'ok' : 'down',
    monitor: checks[2].status === 'fulfilled' ? 'ok' : 'down',
    caddy: checks[3].status === 'fulfilled' && checks[3].value ? 'ok' : 'down',
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
  const [auth, compute, monitor, caddy] = await Promise.allSettled([
    authService.health(),
    computeManager.health(),
    resourceMonitor.health(),
    caddyHealth(),
  ]);

  let monitorStatus = null;
  try {
    monitorStatus = await resourceMonitor.status();
  } catch { /* ignore */ }

  res.json({
    services: {
      auth: {
        url: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
        status: auth.status === 'fulfilled' ? auth.value : { status: 'down' },
      },
      compute: {
        url: process.env.COMPUTE_MANAGER_URL || 'http://localhost:3002',
        status: compute.status === 'fulfilled' ? compute.value : { status: 'down' },
      },
      monitor: {
        url: process.env.RESOURCE_MONITOR_URL || 'http://localhost:3004',
        status: monitor.status === 'fulfilled' ? monitor.value : { status: 'down' },
        containers: monitorStatus,
      },
      caddy: {
        url: process.env.CADDY_ADMIN_URL || 'http://localhost:2019',
        status: caddy.status === 'fulfilled' && caddy.value ? 'ok' : 'down',
      },
    },
    editors: getAllEditors(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
