import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { query } from '../db.js';
import * as podman from '../podman.js';
import { migrateRuntime, snapshotRuntime, restoreFromSnapshot, forkSandbox } from '../migration.js';

const router = Router();

// Plan → resource limits
const PLAN_LIMITS = {
  free:  { memory: 268435456,  cpu: 0.5,  image: 'localhost/mrmd-runtime:latest' },
  pro:   { memory: 536870912,  cpu: 1.0,  image: 'localhost/mrmd-runtime:latest' },
  team:  { memory: 1073741824, cpu: 2.0,  image: 'localhost/mrmd-runtime:latest' },
};

/**
 * POST /runtimes — Start a runtime for a user (local first).
 * Body: { user_id, plan?, language? }
 */
router.post('/', async (req, res, next) => {
  try {
    const { user_id, plan = 'free', language = 'python' } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });

    // Check if user already has a running runtime
    const existing = await query(
      "SELECT * FROM runtimes WHERE user_id = $1 AND state = 'running' LIMIT 1",
      [user_id],
    );
    if (existing.rows.length) {
      const rt = existing.rows[0];

      // Self-heal stale DB rows: if container no longer exists, mark stopped and start fresh.
      let runtimeAlive = false;
      try {
        await podman.getContainerStats(rt.container_name, rt.host);
        runtimeAlive = true;
      } catch {
        runtimeAlive = false;
      }

      if (runtimeAlive) {
        return res.json({
          runtime_id: rt.id,
          container_name: rt.container_name,
          host: rt.host,
          port: rt.port,
          instance_type: rt.instance_type,
          state: rt.state,
        });
      }

      await query("UPDATE runtimes SET state = 'stopped', updated_at = NOW() WHERE id = $1", [rt.id]);
      console.warn(`[runtimes] Stale runtime row detected for ${user_id} (${rt.container_name}), creating fresh runtime`);
    }

    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const shortId = randomUUID().slice(0, 8);
    const containerName = `rt-${user_id}-${shortId}`;
    // Pick a random high port
    const port = 40000 + Math.floor(Math.random() * 20000);

    // Mount user workspace into runtime so Python can access the same project files
    const dataDir = process.env.DATA_DIR || '/data/users';
    const runtimeHome = process.env.RUNTIME_HOME || '/home/ubuntu';
    const userDir = `${dataDir}/${user_id}`;
    mkdirSync(userDir, { recursive: true });

    await podman.startContainer({
      name: containerName,
      image: limits.image,
      memoryLimit: limits.memory,
      cpuLimit: limits.cpu,
      port,
      volumeMount: `${userDir}:${runtimeHome}`,
    });

    const result = await query(
      `INSERT INTO runtimes (user_id, container_name, host, port, memory_limit, cpu_limit, instance_type)
       VALUES ($1, $2, 'localhost', $3, $4, $5, 'local') RETURNING *`,
      [user_id, containerName, port, limits.memory, limits.cpu],
    );
    const rt = result.rows[0];

    res.status(201).json({
      runtime_id: rt.id,
      container_name: rt.container_name,
      host: rt.host,
      port: rt.port,
      instance_type: rt.instance_type,
      state: rt.state,
    });
  } catch (err) { next(err); }
});

/**
 * GET /runtimes/:userId — Get runtime info for a user.
 */
router.get('/:userId', async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT * FROM runtimes WHERE user_id = $1 AND state = 'running' ORDER BY created_at DESC LIMIT 1",
      [req.params.userId],
    );
    if (!rows.length) return res.status(404).json({ error: 'No running runtime' });

    const rt = rows[0];
    // Try to get live stats; if container is gone, mark row stopped.
    let stats = null;
    try {
      stats = await podman.getContainerStats(rt.container_name, rt.host);
      await query('UPDATE runtimes SET memory_used = $1, updated_at = NOW() WHERE id = $2', [stats.memoryUsed, rt.id]);
    } catch {
      await query("UPDATE runtimes SET state = 'stopped', updated_at = NOW() WHERE id = $1", [rt.id]);
      return res.status(404).json({ error: 'No running runtime' });
    }

    res.json({ ...rt, stats });
  } catch (err) { next(err); }
});

/**
 * POST /runtimes/:userId/migrate — Migrate to a different instance type.
 * Body: { target_type }
 */
router.post('/:userId/migrate', async (req, res, next) => {
  try {
    const { target_type } = req.body;
    if (!target_type) return res.status(400).json({ error: 'target_type required' });

    const { rows } = await query(
      "SELECT * FROM runtimes WHERE user_id = $1 AND state = 'running' LIMIT 1",
      [req.params.userId],
    );
    if (!rows.length) return res.status(404).json({ error: 'No running runtime' });

    const result = await migrateRuntime(rows[0].id, target_type);
    res.json(result);
  } catch (err) { next(err); }
});

/**
 * POST /runtimes/:userId/snapshot — Create a CRIU snapshot.
 * Body: { name }
 */
router.post('/:userId/snapshot', async (req, res, next) => {
  try {
    const { name = `snapshot-${Date.now()}` } = req.body || {};
    const { rows } = await query(
      "SELECT * FROM runtimes WHERE user_id = $1 AND state = 'running' LIMIT 1",
      [req.params.userId],
    );
    if (!rows.length) return res.status(404).json({ error: 'No running runtime' });

    const result = await snapshotRuntime(rows[0], name);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

/**
 * POST /runtimes/:userId/restore — Restore from a snapshot.
 * Body: { snapshot_id }
 */
router.post('/:userId/restore', async (req, res, next) => {
  try {
    const { snapshot_id } = req.body;
    if (!snapshot_id) return res.status(400).json({ error: 'snapshot_id required' });

    const result = await restoreFromSnapshot(req.params.userId, snapshot_id);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

/**
 * POST /runtimes/:userId/sandbox — CRIU fork for AI sandbox.
 */
router.post('/:userId/sandbox', async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT * FROM runtimes WHERE user_id = $1 AND state = 'running' LIMIT 1",
      [req.params.userId],
    );
    if (!rows.length) return res.status(404).json({ error: 'No running runtime' });

    const result = await forkSandbox(rows[0]);
    res.status(201).json(result);
  } catch (err) { next(err); }
});

/**
 * DELETE /runtimes/:userId/sandbox/:sandboxId — Destroy a sandbox.
 */
router.delete('/:userId/sandbox/:sandboxId', async (req, res, next) => {
  try {
    const containerName = `sb-${req.params.userId}-${req.params.sandboxId}`;
    const { rows } = await query(
      "SELECT * FROM runtimes WHERE user_id = $1 AND state = 'running' LIMIT 1",
      [req.params.userId],
    );
    const host = rows[0]?.host || 'localhost';
    await podman.removeContainer(containerName, host);
    res.json({ deleted: containerName });
  } catch (err) { next(err); }
});

/**
 * DELETE /runtimes/:userId — Stop and remove the user's runtime.
 */
router.delete('/:userId', async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT * FROM runtimes WHERE user_id = $1 AND state = 'running' LIMIT 1",
      [req.params.userId],
    );
    if (!rows.length) return res.status(404).json({ error: 'No running runtime' });

    const rt = rows[0];
    await podman.removeContainer(rt.container_name, rt.host);
    await query("UPDATE runtimes SET state = 'stopped', updated_at = NOW() WHERE id = $1", [rt.id]);

    // Terminate EC2 instance if runtime was on a remote host
    if (rt.ec2_instance_id && rt.ec2_instance_id !== 'local') {
      try {
        const ec2 = await import('../ec2.js');
        await ec2.terminateInstance(rt.ec2_instance_id);
        console.log(`[runtimes] Terminated EC2 ${rt.ec2_instance_id} for user ${req.params.userId}`);
      } catch (err) {
        console.warn(`[runtimes] Failed to terminate EC2 ${rt.ec2_instance_id}: ${err.message}`);
      }
    }

    res.json({ stopped: rt.id });
  } catch (err) { next(err); }
});

export default router;
