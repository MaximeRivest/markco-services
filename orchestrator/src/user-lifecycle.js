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
import { mkdirSync, existsSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { computeManager, resourceMonitor } from './service-client.js';
// Note: Caddy routes /u/* to orchestrator, which proxies to editor containers.
// No per-user Caddy routes needed.

const execFile = promisify(execFileCb);
const DATA_DIR = process.env.DATA_DIR || '/data/users';
const EDITOR_IMAGE = process.env.EDITOR_IMAGE || 'localhost/mrmd-editor:latest';

/** In-memory map: userId → { editorPort, editorContainer, runtimePort, runtimeId, ... } */
const activeEditors = new Map();

function toLinuxUsername(value, fallback = 'user') {
  const raw = String(value || '').trim().toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');

  let username = cleaned || fallback;
  if (!/^[a-z_]/.test(username)) {
    username = `u_${username}`;
  }
  return username.slice(0, 32);
}

function deriveLinuxUsername(user = {}) {
  return toLinuxUsername(
    user.username
      || (user.email ? user.email.split('@')[0] : '')
      || user.name
      || user.id,
    'user',
  );
}

function writeIfMissing(filePath, content) {
  if (existsSync(filePath)) return;
  writeFileSync(filePath, content, 'utf8');
}

function appendLineIfMissing(filePath, line) {
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  if (existing.includes(line)) return;
  const suffix = existing.endsWith('\n') || existing.length === 0 ? '' : '\n';
  writeFileSync(filePath, `${existing}${suffix}${line}\n`, 'utf8');
}

function ensureUserWorkspace(userId, user = {}) {
  const userDir = `${DATA_DIR}/${userId}`;
  const projectsDir = `${userDir}/Projects`;
  const scratchDir = `${projectsDir}/Scratch`;
  const tutorialDir = `${projectsDir}/Tutorial`;
  const assetsDir = `${scratchDir}/_assets`;

  mkdirSync(userDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  mkdirSync(scratchDir, { recursive: true });
  mkdirSync(tutorialDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(`${userDir}/.npm-global`, { recursive: true });

  // Keep backward compatibility with older paths expecting lowercase "projects"
  const lowerProjectsDir = `${userDir}/projects`;
  if (!existsSync(lowerProjectsDir)) {
    try {
      symlinkSync('Projects', lowerProjectsDir, 'dir');
    } catch {
      // Filesystem may not permit symlink; fallback to real dir.
      mkdirSync(lowerProjectsDir, { recursive: true });
    }
  }

  const displayName = user.name || user.username || user.email || 'there';

  // Linux-like defaults in cloud container shells:
  // - user-local npm global installs (no sudo needed)
  // - helper alias for apt installs with update
  writeIfMissing(`${userDir}/.npmrc`, 'prefix=/home/ubuntu/.npm-global\n');
  appendLineIfMissing(`${userDir}/.bashrc`, 'export PATH="$HOME/.npm-global/bin:$PATH"');
  appendLineIfMissing(`${userDir}/.profile`, 'export PATH="$HOME/.npm-global/bin:$PATH"');
  appendLineIfMissing(`${userDir}/.bashrc`, 'apt() { sudo apt-get update && sudo apt-get "$@"; }');
  appendLineIfMissing(`${userDir}/.bashrc`, "alias apt-install='sudo apt-get update && sudo apt-get install -y'");

  writeIfMissing(`${scratchDir}/mrmd.md`, `# Scratch

This is your temporary workspace.
Use it for quick notes, tests, and throwaway experiments.

\`\`\`yaml config
name: "Scratch"
session:
  python:
    venv: ".venv"
    cwd: "."
    name: "default"
    auto_start: true
\`\`\`
`);

  writeIfMissing(`${scratchDir}/01-scratchpad.md`, `# Scratchpad

Welcome, ${displayName}.

Use this notebook for quick experiments.

\`\`\`python
print("Scratch space ready")
\`\`\`
`);

  writeIfMissing(`${assetsDir}/.gitkeep`, '');

  writeIfMissing(`${tutorialDir}/mrmd.md`, `# Tutorial

\`\`\`yaml config
name: "Tutorial"
session:
  python:
    venv: ".venv"
    cwd: "."
    name: "default"
    auto_start: true
\`\`\`
`);

  writeIfMissing(`${tutorialDir}/01-welcome.md`, `# Welcome to Markco

This project teaches the platform basics.

- Use **Ctrl+P** to open/create files
- Use **Ctrl+Enter** to run the current code cell
- Use **Shift+Enter** to run and move to next cell
`);

  writeIfMissing(`${tutorialDir}/02-editor-basics.md`, `# Editor Basics

## Markdown
Write normal markdown text.

## Code cells
\`\`\`python
x = 21 * 2
x
\`\`\`

Run the cell and output appears inline.
`);

  writeIfMissing(`${tutorialDir}/03-runtimes.md`, `# Runtimes

You can run multiple languages.

\`\`\`bash
echo "hello from bash"
\`\`\`

\`\`\`python
import platform
platform.python_version()
\`\`\`
`);

  writeIfMissing(`${tutorialDir}/04-collaboration.md`, `# Collaboration

This editor is collaborative.
Open the same document in another tab and watch live sync.
`);

  return { userDir, projectsDir, scratchDir, tutorialDir };
}

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
  const linuxUsername = deriveLinuxUsername(user);

  // Ensure user data directory exists with correct ownership for container user (uid 1000, ubuntu)
  mkdirSync(userDir, { recursive: true });
  try {
    await execFile('sudo', ['chown', '-R', '1000:1000', userDir], { timeout: 12000 });
  } catch { /* best effort — may already be correct */ }

  // Remove stale container with same name if it exists
  try {
    await execFile('sudo', ['podman', 'rm', '-f', containerName], { timeout: 10000 });
  } catch { /* didn't exist */ }

  const args = [
    'podman', 'run', '-d',
    '--replace',
    '--restart=on-failure:5',
    '--name', containerName,
    '--network=host',
    '--memory=512m',
    '-v', `${userDir}:/home/ubuntu`,
    '-e', `HOME=/home/ubuntu`,
    '-e', `CLOUD_HOME=/home/ubuntu`,
    '-e', `USER=ubuntu`,
    '-e', `LOGNAME=ubuntu`,
    '-e', `MARKCO_LINUX_USERNAME=${linuxUsername}`,
    '-e', `CLOUD_MODE=1`,
    '-e', `RUNTIME_PORT=${runtimePort}`,
    '-e', `PORT=${editorPort}`,
    '-e', `BASE_PATH=/u/${userId}/`,
    '-e', `CLOUD_USER_ID=${userId}`,
    '-e', `CLOUD_USER_NAME=${user.name || ''}`,
    '-e', `CLOUD_USER_USERNAME=${user.username || ''}`,
    '-e', `CLOUD_USER_EMAIL=${user.email || ''}`,
    '-e', `CLOUD_USER_AVATAR=${user.avatar_url || ''}`,
    '-e', `CLOUD_USER_PLAN=${user.plan || 'free'}`,
    EDITOR_IMAGE,
    'node', '/app/mrmd-server/bin/cli.js',
    '--port', String(editorPort),
    '--host', '0.0.0.0',
    '--no-auth',
    '/home/ubuntu',
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
  // 0. Ensure per-user workspace scaffold exists
  ensureUserWorkspace(userId, user);

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
 * Reconcile running containers on startup.
 * Scans podman for running editor-* and rt-* containers and re-populates
 * the in-memory activeEditors map so the orchestrator can proxy to them.
 */
export async function reconcileContainers() {
  console.log('[lifecycle] Reconciling running containers...');

  try {
    // Get all running containers with their names and env vars
    const { stdout } = await execFile('sudo', [
      'podman', 'ps', '--format', '{{.Names}} {{.Ports}}',
      '--filter', 'status=running',
    ], { timeout: 10000 });

    const lines = stdout.trim().split('\n').filter(Boolean);
    const editorContainers = [];
    const runtimeContainers = [];

    for (const line of lines) {
      const name = line.split(' ')[0];
      if (name.startsWith('editor-')) editorContainers.push(name);
      else if (name.startsWith('rt-')) runtimeContainers.push(name);
    }

    if (editorContainers.length === 0) {
      console.log('[lifecycle] No running editor containers found');
      return;
    }

    for (const containerName of editorContainers) {
      try {
        // Inspect the container to get env vars
        const { stdout: inspectJson } = await execFile('sudo', [
          'podman', 'inspect', '--format', '{{json .Config.Env}}', containerName,
        ], { timeout: 10000 });

        const envArr = JSON.parse(inspectJson.trim());
        const env = {};
        for (const e of envArr) {
          const idx = e.indexOf('=');
          if (idx > 0) env[e.slice(0, idx)] = e.slice(idx + 1);
        }

        const userId = env.CLOUD_USER_ID;
        const editorPort = parseInt(env.PORT, 10);
        const runtimePort = parseInt(env.RUNTIME_PORT, 10);

        if (!userId || !editorPort) {
          console.warn(`[lifecycle] Skipping ${containerName}: missing CLOUD_USER_ID or PORT`);
          continue;
        }

        // Verify the editor is actually responding
        try {
          const res = await fetch(`http://127.0.0.1:${editorPort}/health`, {
            signal: AbortSignal.timeout(3000),
          });
          if (!res.ok) throw new Error(`Status ${res.status}`);
        } catch {
          console.warn(`[lifecycle] Skipping ${containerName}: not responding on port ${editorPort}`);
          continue;
        }

        // Find matching runtime container
        const userIdShort = userId.slice(0, 8);
        const runtimeContainer = runtimeContainers.find(n => n.includes(userId) || n.includes(userIdShort));

        // Look up runtime in DB via compute-manager
        let runtimeId = null;
        try {
          const rt = await computeManager.getRuntime(userId);
          runtimeId = rt.runtime_id || rt.id;
        } catch { /* runtime may not be tracked */ }

        const editorInfo = {
          editorPort,
          editorContainer: containerName,
          runtimeId: runtimeId || null,
          runtimeContainer: runtimeContainer || null,
          runtimePort: runtimePort || 0,
          host: 'localhost',
        };

        activeEditors.set(userId, editorInfo);
        console.log(`[lifecycle] Reconciled user ${userId}: editor :${editorPort}, runtime :${runtimePort || '?'}`);
      } catch (err) {
        console.warn(`[lifecycle] Failed to reconcile ${containerName}: ${err.message}`);
      }
    }

    console.log(`[lifecycle] Reconciliation complete: ${activeEditors.size} active editor(s)`);
  } catch (err) {
    console.error(`[lifecycle] Reconciliation failed: ${err.message}`);
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

/**
 * Periodic health check for active editors.
 * If an editor container dies, attempt to restart it.
 * If a runtime container dies, restart it and notify the editor.
 */
let healthCheckInterval = null;
const HEALTH_CHECK_INTERVAL_MS = 60_000; // every 60 seconds

async function checkEditorHealth(userId, info) {
  // Skip idle editors
  if (info.state === 'idle') return;

  // Check editor health
  let editorAlive = false;
  try {
    const res = await fetch(`http://127.0.0.1:${info.editorPort}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    editorAlive = res.ok;
  } catch { /* dead */ }

  if (!editorAlive) {
    console.warn(`[health] Editor for ${userId} is not responding on port ${info.editorPort}`);

    // Check if the container is stopped but exists (podman restart policy may bring it back)
    try {
      const { stdout } = await execFile('sudo', [
        'podman', 'ps', '-a', '--filter', `name=${info.editorContainer}`,
        '--format', '{{.Status}}',
      ], { timeout: 10000 });

      if (stdout.includes('Exited')) {
        console.log(`[health] Restarting exited editor container ${info.editorContainer}`);
        await execFile('sudo', ['podman', 'start', info.editorContainer], { timeout: 15000 });

        // Wait for it to come back
        try {
          await waitForHealth(info.editorPort, '/health', 15000);
          console.log(`[health] Editor ${info.editorContainer} restarted successfully`);
        } catch {
          console.error(`[health] Editor ${info.editorContainer} failed to restart — removing from active map`);
          activeEditors.delete(userId);
        }
      } else if (!stdout.trim()) {
        // Container is completely gone
        console.warn(`[health] Editor container ${info.editorContainer} is gone — removing from active map`);
        activeEditors.delete(userId);
      }
      // else: container might be starting/restarting, give it time
    } catch (err) {
      console.warn(`[health] Failed to check editor container status: ${err.message}`);
    }
    return;
  }

  // Editor is alive — check runtime
  if (info.runtimePort) {
    let runtimeAlive = false;
    try {
      const res = await fetch(`http://127.0.0.1:${info.runtimePort}/mrp/v1/capabilities`, {
        signal: AbortSignal.timeout(5000),
      });
      runtimeAlive = res.ok;
    } catch { /* dead */ }

    if (!runtimeAlive && info.runtimeContainer) {
      console.warn(`[health] Runtime for ${userId} not responding on port ${info.runtimePort}`);
      try {
        const { stdout } = await execFile('sudo', [
          'podman', 'ps', '-a', '--filter', `name=${info.runtimeContainer}`,
          '--format', '{{.Status}}',
        ], { timeout: 10000 });

        if (stdout.includes('Exited')) {
          console.log(`[health] Restarting exited runtime container ${info.runtimeContainer}`);
          await execFile('sudo', ['podman', 'start', info.runtimeContainer], { timeout: 15000 });
          console.log(`[health] Runtime ${info.runtimeContainer} restarted`);
        }
      } catch (err) {
        console.warn(`[health] Failed to restart runtime: ${err.message}`);
      }
    }
  }
}

export function startHealthChecks() {
  if (healthCheckInterval) return;
  healthCheckInterval = setInterval(async () => {
    for (const [userId, info] of activeEditors) {
      try {
        await checkEditorHealth(userId, info);
      } catch (err) {
        console.warn(`[health] Check failed for ${userId}: ${err.message}`);
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
  // Don't prevent process exit
  healthCheckInterval.unref();
  console.log(`[health] Periodic health checks started (every ${HEALTH_CHECK_INTERVAL_MS / 1000}s)`);
}
