/**
 * Runtime lifecycle management.
 * Reacts to events from resource-monitor to handle elastic scaling.
 */

import { computeManager, resourceMonitor } from './service-client.js';
import { notifyRuntimePortChange, onUserIdle } from './user-lifecycle.js';

/** Track provisioning state to avoid duplicate provisions. */
const provisioningState = new Map();

/**
 * Called when a user executes their first code cell and has no runtime yet.
 * Starts a co-located (local) runtime via compute-manager.
 *
 * @param {string} userId
 * @param {string} [plan='free']
 * @param {string} [language='python']
 * @returns {Object} Runtime info
 */
export async function onFirstCellExecution(userId, plan = 'free', language = 'python') {
  console.log(`[runtime] First cell execution for user ${userId}, starting ${language} runtime`);

  const runtime = await computeManager.startRuntime(userId, plan, language);

  // Register with resource-monitor for threshold tracking
  try {
    await resourceMonitor.register(
      runtime.runtime_id,
      runtime.container_name,
      runtime.host || 'localhost',
      0,
    );
  } catch (err) {
    console.warn(`[runtime] Monitor registration failed: ${err.message}`);
  }

  console.log(`[runtime] Runtime started for ${userId}: ${runtime.container_name} on port ${runtime.port}`);
  return runtime;
}

/**
 * Pre-provision event (50% memory threshold).
 * Tells compute-manager to provision a bigger EC2 instance in advance.
 * The instance sits idle until migration is needed.
 */
export async function onPreProvision(event) {
  const { runtime_id, container_name } = event;
  const key = `provision-${runtime_id}`;

  if (provisioningState.has(key)) {
    console.log(`[runtime] Pre-provision already in progress for ${runtime_id}`);
    return provisioningState.get(key);
  }

  console.log(`[runtime] Pre-provisioning for ${runtime_id} (${event.memory_percent}% memory)`);

  // Determine target type based on current usage
  const targetType = selectUpgradeType(event);

  const promise = computeManager.migrate(extractUserId(container_name), targetType)
    .then(result => {
      console.log(`[runtime] Pre-provision ready for ${runtime_id}: ${targetType}`);
      provisioningState.delete(key);
      return result;
    })
    .catch(err => {
      console.error(`[runtime] Pre-provision failed for ${runtime_id}: ${err.message}`);
      provisioningState.delete(key);
      throw err;
    });

  provisioningState.set(key, promise);
  return promise;
}

/**
 * Migrate event (75% memory threshold).
 * Tells compute-manager to CRIU migrate the container to a bigger instance.
 * Uses --leave-running for zero downtime.
 */
export async function onMigrate(event) {
  const { runtime_id, container_name } = event;
  const userId = extractUserId(container_name);
  const targetType = selectUpgradeType(event);

  console.log(`[runtime] Migrating ${runtime_id} to ${targetType} (${event.memory_percent}% memory)`);

  try {
    const result = await computeManager.migrate(userId, targetType);

    // Notify editor container of the new runtime location (hot-reload, no restart)
    const rtInfo = await computeManager.getRuntime(userId);
    if (rtInfo?.port) {
      await notifyRuntimePortChange(userId, rtInfo.port, rtInfo.host);
    }

    console.log(`[runtime] Migration complete for ${runtime_id}: ckpt=${result.checkpointMs}ms xfer=${result.transferMs}ms restore=${result.restoreMs}ms`);
    return result;
  } catch (err) {
    console.error(`[runtime] Migration failed for ${runtime_id}: ${err.message}`);
    throw err;
  }
}

/**
 * GPU hint event (code analysis detected GPU-heavy workload).
 * Provisions a GPU instance and migrates.
 */
export async function onGpuHint(event) {
  const { runtime_id, container_name } = event;
  const userId = extractUserId(container_name);

  console.log(`[runtime] GPU hint for ${runtime_id}, migrating to GPU instance`);

  try {
    const result = await computeManager.migrate(userId, 'g4dn.xlarge');
    console.log(`[runtime] GPU migration complete for ${runtime_id}`);
    return result;
  } catch (err) {
    console.error(`[runtime] GPU migration failed for ${runtime_id}: ${err.message}`);
    throw err;
  }
}

/**
 * Idle sleep event.
 * Delegates to user-lifecycle which handles snapshot + stop of both containers.
 */
export async function onIdleSleep(event) {
  const { runtime_id, container_name } = event;
  const userId = extractUserId(container_name);

  console.log(`[runtime] Idle sleep for ${runtime_id}`);
  await onUserIdle(userId);
  console.log(`[runtime] Runtime ${runtime_id} put to sleep`);
}

/**
 * Select an upgrade instance type based on current resource usage.
 */
function selectUpgradeType(event) {
  const memPercent = event.memory_percent || 0;
  if (memPercent >= 90) return 't3.xlarge';
  if (memPercent >= 75) return 't3.large';
  if (memPercent >= 50) return 't3.medium';
  return 't3.small';
}

/**
 * Extract userId from container name (format: rt-{userId}-{shortId}).
 */
function extractUserId(containerName) {
  if (!containerName) return null;
  const parts = containerName.split('-');
  // rt-{userId}-{shortId} — userId could be a UUID with dashes
  // Take everything between first "rt-" and last "-shortId"
  if (parts.length >= 3 && parts[0] === 'rt') {
    return parts.slice(1, -1).join('-');
  }
  return containerName;
}
