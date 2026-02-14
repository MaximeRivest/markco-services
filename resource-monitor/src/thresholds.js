import { pushEvent } from './events.js';

const DEBOUNCE_MS = 60_000;
const IDLE_TIMEOUT_MINUTES = parseInt(process.env.IDLE_TIMEOUT_MINUTES ?? '15', 10);

/**
 * Per-container state: last event type emitted + timestamp, idle tracking.
 * Key = runtime_id
 */
const state = new Map();

const THRESHOLDS = [
  { percent: 95, type: 'critical' },
  { percent: 90, type: 'urgent-migrate' },
  { percent: 75, type: 'migrate' },
  { percent: 50, type: 'pre-provision' },
];

function getState(runtimeId) {
  if (!state.has(runtimeId)) {
    state.set(runtimeId, {
      lastEmitted: new Map(),   // type → timestamp
      lastActiveCpu: Date.now(),
      idleSleepEmitted: false,
    });
  }
  return state.get(runtimeId);
}

function clearState(runtimeId) {
  state.delete(runtimeId);
}

/**
 * Check memory thresholds for a container and emit the highest matching event.
 * Only the single highest threshold fires (avoids spamming lower ones).
 */
function checkThresholds(container, stats) {
  const { runtime_id, container_name, host, memory_limit } = container;
  const { memory_used, cpu_percent } = stats;
  const memPercent = memory_limit > 0 ? (memory_used / memory_limit) * 100 : 0;
  const s = getState(runtime_id);
  const now = Date.now();

  // --- Memory thresholds (emit only the highest crossing) ---
  for (const { percent, type } of THRESHOLDS) {
    if (memPercent >= percent) {
      const last = s.lastEmitted.get(type) ?? 0;
      if (now - last > DEBOUNCE_MS) {
        s.lastEmitted.set(type, now);
        pushEvent({
          type,
          runtime_id,
          container_name,
          host,
          memory_used,
          memory_limit,
          memory_percent: Math.round(memPercent * 100) / 100,
          timestamp: new Date().toISOString(),
        });
      }
      break; // only the highest
    }
  }

  // --- Idle detection ---
  if (cpu_percent > 1) {
    s.lastActiveCpu = now;
    if (s.idleSleepEmitted) {
      s.idleSleepEmitted = false;
      const last = s.lastEmitted.get('idle-wake') ?? 0;
      if (now - last > DEBOUNCE_MS) {
        s.lastEmitted.set('idle-wake', now);
        pushEvent({
          type: 'idle-wake',
          runtime_id,
          container_name,
          host,
          memory_used,
          memory_limit,
          memory_percent: Math.round(memPercent * 100) / 100,
          timestamp: new Date().toISOString(),
        });
      }
    }
  } else {
    const idleMs = now - s.lastActiveCpu;
    if (idleMs >= IDLE_TIMEOUT_MINUTES * 60_000 && !s.idleSleepEmitted) {
      s.idleSleepEmitted = true;
      const last = s.lastEmitted.get('idle-sleep') ?? 0;
      if (now - last > DEBOUNCE_MS) {
        s.lastEmitted.set('idle-sleep', now);
        pushEvent({
          type: 'idle-sleep',
          runtime_id,
          container_name,
          host,
          memory_used,
          memory_limit,
          memory_percent: Math.round(memPercent * 100) / 100,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}

export { checkThresholds, clearState, getState, THRESHOLDS, DEBOUNCE_MS };
