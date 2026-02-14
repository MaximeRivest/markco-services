import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkThresholds } from './thresholds.js';

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? '5000', 10);

/** Map of runtime_id → container info. */
const monitored = new Map();

/** Latest stats snapshot per runtime_id. */
const latestStats = new Map();

let pollTimer = null;

function register(container) {
  const { runtime_id } = container;
  monitored.set(runtime_id, { ...container });
}

function unregister(runtimeId) {
  monitored.delete(runtimeId);
  latestStats.delete(runtimeId);
}

function getAll() {
  const result = {};
  for (const [id, container] of monitored) {
    result[id] = { ...container, stats: latestStats.get(id) ?? null };
  }
  return result;
}

/**
 * Parse podman stats JSON output into normalised numbers.
 * podman stats --format json returns an array of objects with keys like
 * MemUsage "401.7MB / 512MB", CPU "12.34%", etc.
 * We find the entry matching our container name.
 */
function parseStats(jsonArr, containerName) {
  const entry = jsonArr.find(
    (e) => e.Name === containerName || e.ID?.startsWith(containerName),
  );
  if (!entry) return null;

  const memParts = (entry.MemUsage ?? '').split('/').map((s) => s.trim());
  const memory_used = parseSize(memParts[0] ?? '0');
  const memory_limit = parseSize(memParts[1] ?? '0');
  const cpu_percent = parseFloat(entry.CPU) || 0;

  return { memory_used, memory_limit, cpu_percent };
}

function parseSize(str) {
  const match = str.match(/([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)?/i);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = (match[2] ?? 'B').toUpperCase();
  const factors = {
    B: 1, KB: 1e3, KIB: 1024,
    MB: 1e6, MIB: 1048576,
    GB: 1e9, GIB: 1073741824,
    TB: 1e12, TIB: 1099511627776,
  };
  return Math.round(num * (factors[unit] ?? 1));
}

async function pollContainer(container) {
  const { container_name, host } = container;
  try {
    let stdout;
    if (!host || host === 'localhost' || host === '127.0.0.1') {
      ({ stdout } = await execFileAsync('podman', [
        'stats', '--no-stream', '--format', 'json',
      ], { timeout: 10_000 }));
    } else {
      ({ stdout } = await execFileAsync('ssh', [
        '-o', 'ConnectTimeout=5',
        '-o', 'StrictHostKeyChecking=accept-new',
        host,
        'podman', 'stats', '--no-stream', '--format', 'json',
      ], { timeout: 15_000 }));
    }

    const jsonArr = JSON.parse(stdout);
    const stats = parseStats(jsonArr, container_name);
    if (!stats) return;

    // Use the registered memory_limit if podman didn't report one or it's zero.
    if (stats.memory_limit === 0 && container.memory_limit) {
      stats.memory_limit = container.memory_limit;
    }
    latestStats.set(container.runtime_id, { ...stats, polled_at: new Date().toISOString() });
    checkThresholds(container, stats);
  } catch {
    // Polling failure for a single container shouldn't stop the loop.
  }
}

async function pollAll() {
  const promises = [];
  for (const container of monitored.values()) {
    promises.push(pollContainer(container));
  }
  await Promise.allSettled(promises);
}

function start() {
  if (pollTimer) return;
  pollTimer = setInterval(pollAll, POLL_INTERVAL_MS);
  // Run immediately on start too.
  pollAll();
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export { register, unregister, getAll, start, stop, pollAll, parseStats, parseSize };
