import { query } from './db.js';
import * as podman from './podman.js';
import * as ec2 from './ec2.js';
import { mkdirSync } from 'node:fs';

const SNAPSHOT_BASE = '/data/snapshots';

/**
 * Full CRIU migration: checkpoint with --leave-running, transfer, restore, switch.
 * @param {string} runtimeId - UUID of the runtime row
 * @param {string} targetType - EC2 instance type to migrate to
 * @returns {Promise<Object>} migration record
 */
export async function migrateRuntime(runtimeId, targetType) {
  // 1. Load runtime info
  const { rows } = await query('SELECT * FROM runtimes WHERE id = $1', [runtimeId]);
  if (!rows.length) throw new Error(`Runtime ${runtimeId} not found`);
  const runtime = rows[0];

  // 2. Create migration record
  const migRes = await query(
    `INSERT INTO migrations (runtime_id, from_instance, to_instance, from_type, to_type, status, started_at)
     VALUES ($1, $2, '', $3, $4, 'in-progress', NOW()) RETURNING *`,
    [runtimeId, runtime.ec2_instance_id || 'local', runtime.instance_type, targetType],
  );
  const migration = migRes.rows[0];

  try {
    // 3. Provision target EC2
    const { instanceId, privateIp } = await ec2.provisionInstance(targetType);

    await query('UPDATE migrations SET to_instance = $1 WHERE id = $2', [instanceId, migration.id]);

    // 4. Checkpoint with --leave-running (zero downtime)
    const exportPath = `/tmp/migrate-${runtime.container_name}.tar.gz`;
    const ckpt = await podman.checkpointContainer(
      runtime.container_name, exportPath, true, runtime.host,
    );

    // 5. SCP to target
    const remotePath = `/tmp/${runtime.container_name}.tar.gz`;
    const transfer = await podman.scpTo(exportPath, privateIp, remotePath);

    // 6. Restore on target (same port — different host, no conflict)
    const newName = runtime.container_name;
    const restore = await podman.restoreContainer(remotePath, newName, privateIp, {
      port: runtime.port,
    });

    // 7. Update runtime record (atomic proxy switch)
    await query(
      `UPDATE runtimes SET host = $1, port = $2, ec2_instance_id = $3, instance_type = $4, updated_at = NOW()
       WHERE id = $5`,
      [privateIp, runtime.port, instanceId, targetType, runtimeId],
    );

    // 8. Kill old container
    await podman.removeContainer(runtime.container_name, runtime.host);

    // 8b. Terminate old EC2 instance if source was remote
    if (runtime.ec2_instance_id && runtime.ec2_instance_id !== 'local') {
      try {
        await ec2.terminateInstance(runtime.ec2_instance_id);
        console.log(`[migration] Terminated old EC2 ${runtime.ec2_instance_id}`);
      } catch (err) {
        console.warn(`[migration] Failed to terminate old EC2 ${runtime.ec2_instance_id}: ${err.message}`);
      }
    }

    // 9. Record metrics
    await query(
      `UPDATE migrations SET status = 'completed', checkpoint_ms = $1, transfer_ms = $2,
       restore_ms = $3, completed_at = NOW() WHERE id = $4`,
      [ckpt.durationMs, transfer.durationMs, restore.durationMs, migration.id],
    );

    console.log(`[migration] ${runtimeId} → ${targetType} done: ckpt=${ckpt.durationMs}ms xfer=${transfer.durationMs}ms restore=${restore.durationMs}ms`);

    return {
      migrationId: migration.id,
      instanceId,
      privateIp,
      checkpointMs: ckpt.durationMs,
      transferMs: transfer.durationMs,
      restoreMs: restore.durationMs,
    };
  } catch (err) {
    await query(
      'UPDATE migrations SET status = $1, completed_at = NOW() WHERE id = $2',
      [`failed: ${err.message}`, migration.id],
    );
    // Clean up provisioned EC2 on failure
    try {
      const mig = (await query('SELECT to_instance FROM migrations WHERE id = $1', [migration.id])).rows[0];
      if (mig?.to_instance) await ec2.terminateInstance(mig.to_instance);
    } catch (cleanupErr) {
      console.error(`[migration] cleanup failed:`, cleanupErr.message);
    }
    throw err;
  }
}

/**
 * Create a CRIU snapshot of a running runtime (for persistence/hibernation).
 * @param {Object} runtime - runtime DB row
 * @param {string} snapshotName - name for the snapshot
 * @param {Object} [opts]
 * @param {boolean} [opts.leaveRunning=true] - keep container running after checkpoint
 */
export async function snapshotRuntime(runtime, snapshotName, opts = {}) {
  const leaveRunning = opts.leaveRunning !== false;
  const dir = `${SNAPSHOT_BASE}/${runtime.user_id}`;
  mkdirSync(dir, { recursive: true });
  const exportPath = `${dir}/${snapshotName}.tar.gz`;

  const { durationMs } = await podman.checkpointContainer(
    runtime.container_name, exportPath, leaveRunning, runtime.host,
  );

  const { statSync } = await import('node:fs');
  const stat = statSync(exportPath);

  const res = await query(
    `INSERT INTO snapshots (user_id, runtime_id, name, path, size_bytes)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [runtime.user_id, runtime.id, snapshotName, exportPath, stat.size],
  );

  return { snapshot: res.rows[0], durationMs };
}

/**
 * Restore a runtime from a CRIU snapshot.
 */
export async function restoreFromSnapshot(userId, snapshotId) {
  const { rows } = await query('SELECT * FROM snapshots WHERE id = $1 AND user_id = $2', [snapshotId, userId]);
  if (!rows.length) throw new Error('Snapshot not found');
  const snapshot = rows[0];

  const shortId = snapshot.id.slice(0, 8);
  const containerName = `rt-${userId}-${shortId}`;
  const port = 40000 + Math.floor(Math.random() * 20000);
  const { containerId, durationMs } = await podman.restoreContainer(
    snapshot.path, containerName, null, { port },
  );

  const res = await query(
    `INSERT INTO runtimes (user_id, container_name, host, port, state, instance_type)
     VALUES ($1, $2, 'localhost', $3, 'running', 'local') RETURNING *`,
    [userId, containerName, port],
  );

  return { runtime: res.rows[0], durationMs };
}

/**
 * CRIU fork: checkpoint --leave-running, then restore a copy as a sandbox.
 */
export async function forkSandbox(runtime) {
  const shortId = Math.random().toString(36).slice(2, 10);
  const sandboxName = `sb-${runtime.user_id}-${shortId}`;
  const exportPath = `/tmp/sandbox-${sandboxName}.tar.gz`;

  const ckpt = await podman.checkpointContainer(
    runtime.container_name, exportPath, true, runtime.host,
  );
  const sandboxPort = 40000 + Math.floor(Math.random() * 20000);
  const restore = await podman.restoreContainer(
    exportPath, sandboxName, runtime.host, { port: sandboxPort },
  );

  return {
    sandboxId: shortId,
    containerName: sandboxName,
    host: runtime.host,
    port: sandboxPort,
    checkpointMs: ckpt.durationMs,
    restoreMs: restore.durationMs,
  };
}
