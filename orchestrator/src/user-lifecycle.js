/**
 * User lifecycle management.
 *
 * Starts two containers per user:
 *   1. Runtime container (mrmd-python) — CRIU-migratable, elastic compute
 *   2. Editor container (mrmd-server) — serves UI, proxies to runtime
 *
 * Manages Caddy routing so /u/{userId}/* reaches the editor container.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { computeManager, resourceMonitor } from './service-client.js';
// Note: Caddy routes /u/* to orchestrator, which proxies to editor containers.
// No per-user Caddy routes needed.

const execFile = promisify(execFileCb);
const DATA_DIR = process.env.DATA_DIR || '/data/users';
const EDITOR_IMAGE = process.env.EDITOR_IMAGE || 'localhost/mrmd-editor:latest';

/** In-memory map: userId → { editorPort, editorContainer, runtimePort, runtimeId, ... } */
const activeEditors = new Map();

/**
 * Find a free port on the host.
 */
function randomPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

/**
 * Wait for an HTTP endpoint to become reachable.
 */
async function waitForHealth(port, path = '/health', timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Port ${port} not ready after ${timeoutMs}ms`);
}

/**
 * Start an editor container via podman.
 * Uses --network=host so the editor can reach the runtime container's host-mapped port.
 */
async function startEditorContainer(userId, editorPort, runtimePort, user = {}) {
  const containerName = `editor-${userId.slice(0, 8)}`;
  const userDir = `${DATA_DIR}/${userId}`;

  // Ensure user data directory exists
  mkdirSync(userDir, { recursive: true });

  // Remove stale container with same name if it exists
  try {
    await execFile('sudo', ['podman', 'rm', '-f', containerName], { timeout: 10000 });
  } catch { /* didn't exist */ }

  const args = [
    'podman', 'run', '-d',
    '--replace',
    '--name', containerName,
    '--network=host',
    '--memory=512m',
    '-v', `${userDir}:/home/user`,
    '-e', `CLOUD_MODE=1`,
    '-e', `RUNTIME_PORT=${runtimePort}`,
    '-e', `PORT=${editorPort}`,
    '-e', `BASE_PATH=/u/${userId}/`,
    '-e', `CLOUD_USER_ID=${userId}`,
    '-e', `CLOUD_USER_NAME=${user.name || ''}`,
    '-e', `CLOUD_USER_EMAIL=${user.email || ''}`,
    '-e', `CLOUD_USER_AVATAR=${user.avatar_url || ''}`,
    '-e', `CLOUD_USER_PLAN=${user.plan || 'free'}`,
    EDITOR_IMAGE,
    'node', '/app/mrmd-server/bin/cli.js',
    '--port', String(editorPort),
    '--host', '0.0.0.0',
    '--no-auth',
    '/home/user',
  ];

  const { stdout } = await execFile('sudo', args, { timeout: 30000 });
  return { containerName, containerId: stdout.trim() };
}

/**
 * Stop and remove an editor container.
 */
async function stopEditorContainer(containerName) {
  try {
    await execFile('sudo', ['podman', 'rm', '-f', containerName], { timeout: 15000 });
  } catch (err) {
    if (!err.stderr?.includes('no such container')) {
      console.warn(`[lifecycle] Error removing editor ${containerName}: ${err.message}`);
    }
  }
}

/**
 * Called after successful OAuth login.
 * Starts runtime + editor containers and configures Caddy routing.
 */
const startingUsers = new Set();
export async function onUserLogin(user) {
  const userId = user.id;

  // Prevent concurrent starts for same user
  if (startingUsers.has(userId)) {
    // Wait for the in-flight start to finish
    while (startingUsers.has(userId)) await new Promise(r => setTimeout(r, 500));
    if (activeEditors.has(userId)) return activeEditors.get(userId);
  }

  // Check if already running
  if (activeEditors.has(userId)) {
    const existing = activeEditors.get(userId);
    if (existing.state !== 'idle') {
      console.log(`[lifecycle] User ${userId} already has editor on port ${existing.editorPort}`);
      return existing;
    }
    // Was idle, start fresh
    activeEditors.delete(userId);
  }

  startingUsers.add(userId);
  try {
  // 1. Start runtime container via compute-manager
  const runtime = await computeManager.startRuntime(userId, user.plan || 'free');
  console.log(`[lifecycle] Runtime started for ${userId}: port ${runtime.port}`);

  // 2. Start editor container
  const editorPort = randomPort();
  const { containerName: editorContainer } = await startEditorContainer(
    userId, editorPort, runtime.port, user,
  );
  console.log(`[lifecycle] Editor container ${editorContainer} started on port ${editorPort}`);

  // 3. Wait for editor to be ready
  await waitForHealth(editorPort);

  // 4. Register runtime with resource-monitor
  try {
    await resourceMonitor.register(
      runtime.runtime_id,
      runtime.container_name,
      runtime.host || 'localhost',
      0,
    );
  } catch (err) {
    console.warn(`[lifecycle] Failed to register with resource-monitor: ${err.message}`);
  }

  const editorInfo = {
    editorPort,
    editorContainer,
    runtimeId: runtime.runtime_id,
    runtimeContainer: runtime.container_name,
    runtimePort: runtime.port,
    host: 'localhost',
  };

  activeEditors.set(userId, editorInfo);
  console.log(`[lifecycle] User ${userId} fully started: editor :${editorPort}, runtime :${runtime.port}`);
  return editorInfo;
  } finally {
    startingUsers.delete(userId);
  }
}

/**
 * Called when user logs out.
 * Stops editor container. Optionally snapshots + stops runtime.
 */
export async function onUserLogout(userId) {
  const editor = activeEditors.get(userId);

  if (editor) {
    // Stop editor container
    await stopEditorContainer(editor.editorContainer);

    // Unregister from monitoring
    try {
      await resourceMonitor.unregister(editor.runtimeId);
    } catch { /* best effort */ }

    // Stop runtime container
    try {
      await computeManager.stopRuntime(userId);
    } catch (err) {
      console.warn(`[lifecycle] Failed to stop runtime for ${userId}: ${err.message}`);
    }

    activeEditors.delete(userId);
  }

  console.log(`[lifecycle] User ${userId} logged out, containers stopped`);
}

/**
 * Called when resource-monitor detects idle.
 * Snapshots the runtime, stops both containers.
 */
export async function onUserIdle(userId) {
  const editor = activeEditors.get(userId);
  if (!editor) return;

  // Snapshot runtime before stopping
  let snapshotId = null;
  try {
    const result = await computeManager.snapshot(userId, `idle-${Date.now()}`);
    snapshotId = result.snapshot?.id;
    console.log(`[lifecycle] Snapshot for idle ${userId}: ${snapshotId}`);
  } catch (err) {
    console.warn(`[lifecycle] Snapshot failed for ${userId}: ${err.message}`);
  }

  // Unregister from monitoring
  try {
    await resourceMonitor.unregister(editor.runtimeId);
  } catch { /* best effort */ }

  // Stop both containers
  await stopEditorContainer(editor.editorContainer);
  try {
    await computeManager.stopRuntime(userId);
  } catch (err) {
    console.warn(`[lifecycle] Failed to stop idle runtime for ${userId}: ${err.message}`);
  }

  // Mark as idle (keep snapshot reference)
  activeEditors.set(userId, { ...editor, state: 'idle', snapshotId });
  console.log(`[lifecycle] User ${userId} idle, snapshotted and stopped`);
}

/**
 * Called when a previously idle user returns.
 * Restores runtime from snapshot, starts new editor container.
 */
export async function onUserReturn(userId) {
  const editor = activeEditors.get(userId);

  if (editor?.snapshotId) {
    try {
      // Restore runtime from snapshot
      const result = await computeManager.restore(userId, editor.snapshotId);
      const rt = result.runtime;

      // Start new editor container pointing to restored runtime
      const editorPort = randomPort();
      const { containerName: editorContainer } = await startEditorContainer(
        userId, editorPort, rt.port,
      );
      await waitForHealth(editorPort);

      // Re-register with monitor
      try {
        await resourceMonitor.register(rt.id, rt.container_name, rt.host || 'localhost', 0);
      } catch { /* best effort */ }

      const newInfo = {
        editorPort,
        editorContainer,
        runtimeId: rt.id,
        runtimeContainer: rt.container_name,
        runtimePort: rt.port,
        host: 'localhost',
      };

      activeEditors.set(userId, newInfo);
      console.log(`[lifecycle] User ${userId} restored from snapshot`);
      return newInfo;
    } catch (err) {
      console.warn(`[lifecycle] Restore failed for ${userId}, starting fresh: ${err.message}`);
      activeEditors.delete(userId);
    }
  }

  // Fallback: start fresh
  return onUserLogin({ id: userId, plan: 'free' });
}

/**
 * Notify the editor container that the runtime location has changed (after CRIU migration).
 * Calls the editor's /api/runtime/update-port endpoint for hot-reload.
 */
export async function notifyRuntimePortChange(userId, newPort, newHost) {
  const editor = activeEditors.get(userId);
  if (!editor || editor.state === 'idle') return;

  try {
    const res = await fetch(`http://127.0.0.1:${editor.editorPort}/api/runtime/update-port`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: newPort, host: newHost || 'localhost' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`Status ${res.status}`);
    // Update local state
    editor.runtimePort = newPort;
    editor.host = newHost || 'localhost';
    console.log(`[lifecycle] Notified editor for ${userId}: runtime → ${newHost || 'localhost'}:${newPort}`);
  } catch (err) {
    console.warn(`[lifecycle] Failed to notify editor of port change for ${userId}: ${err.message}`);
  }
}

/**
 * Get the active editor info for a user, or null.
 */
export function getEditorInfo(userId) {
  const info = activeEditors.get(userId);
  if (!info || info.state === 'idle') return null;
  return info;
}

/**
 * Get all active editors (for status/health).
 */
export function getAllEditors() {
  return Object.fromEntries(activeEditors);
}
