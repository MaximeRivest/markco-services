/**
 * Webhook receiver for resource-monitor events.
 * Routes events to the correct lifecycle handler.
 */

import { Router } from 'express';
import { onPreProvision, onMigrate, onGpuHint, onIdleSleep } from './runtime-lifecycle.js';
import { onUserIdle } from './user-lifecycle.js';

const router = Router();

/**
 * POST /hooks/resource — receive events from resource-monitor.
 *
 * Event types (from thresholds.js):
 *   pre-provision  — 50% memory threshold
 *   migrate        — 75% memory threshold
 *   urgent-migrate — 90% memory threshold
 *   critical       — 95% memory threshold
 *   idle-sleep     — CPU idle for IDLE_TIMEOUT_MINUTES
 *   idle-wake      — CPU active again after idle
 *   gpu-hint       — code analyzer detected GPU workload
 */
router.post('/hooks/resource', async (req, res) => {
  const event = req.body;

  if (!event || !event.type) {
    return res.status(400).json({ error: 'Missing event type' });
  }

  console.log(`[event] Received: ${event.type} for runtime ${event.runtime_id} (${event.memory_percent || 0}% mem)`);

  // Respond immediately, handle async
  res.json({ received: true });

  try {
    switch (event.type) {
      case 'pre-provision':
        await onPreProvision(event);
        break;

      case 'migrate':
        await onMigrate(event);
        break;

      case 'urgent-migrate':
        // Same as migrate but more urgent
        await onMigrate(event);
        break;

      case 'critical':
        // Critical: force migrate to largest available
        event.memory_percent = 95;
        await onMigrate(event);
        break;

      case 'idle-sleep':
        await onIdleSleep(event);
        break;

      case 'idle-wake':
        // No action needed — runtime is still running
        console.log(`[event] Runtime ${event.runtime_id} woke from idle`);
        break;

      case 'gpu-hint':
        await onGpuHint(event);
        break;

      default:
        console.log(`[event] Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error(`[event] Error handling ${event.type}: ${err.message}`);
  }
});

export default router;
