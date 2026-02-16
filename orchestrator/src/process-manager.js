/**
 * Process manager: starts and monitors all Layer 3 services as child processes.
 * Restarts crashed services and handles graceful shutdown.
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVICES_DIR = resolve(__dirname, '..', '..');

const SERVICE_DEFS = [
  {
    name: 'auth-service',
    dir: resolve(SERVICES_DIR, 'auth-service'),
    command: 'node',
    args: ['src/index.js'],
    port: 3001,
    healthPath: '/health',
    env: { PORT: '3001' },
  },
  {
    name: 'compute-manager',
    dir: resolve(SERVICES_DIR, 'compute-manager'),
    command: 'node',
    args: ['src/index.js'],
    port: 3002,
    healthPath: '/health',
    env: { PORT: '3002' },
  },
  {
    name: 'publish-service',
    dir: resolve(SERVICES_DIR, 'publish-service'),
    command: 'node',
    args: ['src/index.js'],
    port: 3003,
    healthPath: '/@_health/_check', // will 404 but that means it's up
    env: { PORT: '3003' },
  },
  {
    name: 'resource-monitor',
    dir: resolve(SERVICES_DIR, 'resource-monitor'),
    command: 'node',
    args: ['src/index.js'],
    port: 3004,
    healthPath: '/health',
    env: { PORT: '3004' },
  },
  {
    name: 'sync-relay',
    dir: resolve(SERVICES_DIR, 'sync-relay'),
    command: 'node',
    args: ['src/index.js'],
    port: parseInt(process.env.SYNC_RELAY_PORT || '3006', 10),
    healthPath: '/health',
    env: { PORT: process.env.SYNC_RELAY_PORT || '3006' },
  },
];

/** Map of service name → { process, def, restartCount } */
const managed = new Map();
let shuttingDown = false;

/**
 * Start a single service.
 */
function startService(def) {
  if (shuttingDown) return;

  const env = { ...process.env, ...def.env };
  const child = spawn(def.command, def.args, {
    cwd: def.dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const entry = managed.get(def.name) || { process: null, def, restartCount: 0 };
  entry.process = child;
  managed.set(def.name, entry);

  child.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      console.log(`[${def.name}] ${line}`);
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      console.error(`[${def.name}] ${line}`);
    }
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;

    console.error(`[pm] ${def.name} exited (code=${code}, signal=${signal})`);
    entry.restartCount++;

    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
    const delay = Math.min(1000 * Math.pow(2, entry.restartCount - 1), 30000);
    console.log(`[pm] Restarting ${def.name} in ${delay}ms (attempt #${entry.restartCount})`);
    setTimeout(() => startService(def), delay);
  });

  console.log(`[pm] Started ${def.name} (pid=${child.pid})`);
}

/**
 * Check if a service is healthy by hitting its health endpoint.
 */
async function checkHealth(def) {
  try {
    const res = await fetch(`http://localhost:${def.port}${def.healthPath}`, {
      signal: AbortSignal.timeout(3000),
    });
    // 200 or even 404 means the service is up and responding
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Wait for a service to become healthy (up to timeoutMs).
 */
async function waitForHealth(def, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await checkHealth(def)) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * Start all services and wait for them to be healthy.
 */
export async function startAll() {
  console.log('[pm] Starting all services...');

  for (const def of SERVICE_DEFS) {
    // Check if service is already running externally
    if (await checkHealth(def)) {
      console.log(`[pm] ${def.name} already running on port ${def.port}`);
      continue;
    }
    startService(def);
  }

  // Wait for all to be healthy
  const results = await Promise.all(
    SERVICE_DEFS.map(async (def) => {
      const healthy = await waitForHealth(def);
      if (healthy) {
        console.log(`[pm] ${def.name} is healthy`);
        // Reset restart count on successful health
        const entry = managed.get(def.name);
        if (entry) entry.restartCount = 0;
      } else {
        console.error(`[pm] ${def.name} failed health check after 30s`);
      }
      return { name: def.name, healthy };
    })
  );

  const allHealthy = results.every(r => r.healthy);
  if (!allHealthy) {
    const failed = results.filter(r => !r.healthy).map(r => r.name);
    console.warn(`[pm] Some services failed to start: ${failed.join(', ')}`);
  }

  return results;
}

/**
 * Gracefully stop all managed services.
 */
export async function stopAll() {
  shuttingDown = true;
  console.log('[pm] Stopping all services...');

  const promises = [];
  for (const [name, entry] of managed) {
    if (entry.process && !entry.process.killed) {
      promises.push(new Promise((resolve) => {
        entry.process.on('exit', resolve);
        entry.process.kill('SIGTERM');
        // Force kill after 5s
        setTimeout(() => {
          if (!entry.process.killed) {
            entry.process.kill('SIGKILL');
          }
          resolve();
        }, 5000);
      }));
      console.log(`[pm] Sent SIGTERM to ${name} (pid=${entry.process.pid})`);
    }
  }

  await Promise.all(promises);
  managed.clear();
  console.log('[pm] All services stopped');
}

/**
 * Get status of all managed services.
 */
export function getStatus() {
  const status = {};
  for (const [name, entry] of managed) {
    status[name] = {
      pid: entry.process?.pid,
      killed: entry.process?.killed || false,
      restartCount: entry.restartCount,
    };
  }
  return status;
}
