import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { checkThresholds, clearState, getState } from '../src/thresholds.js';
import { bus, getRecentEvents } from '../src/events.js';

const MB = 1_048_576;

function makeContainer(overrides = {}) {
  return {
    runtime_id: 'test-1',
    container_name: 'rt-test',
    host: 'localhost',
    memory_limit: 512 * MB,
    ...overrides,
  };
}

describe('thresholds', () => {
  beforeEach(() => {
    clearState('test-1');
    // Drain recent events by reading them (they persist across tests in-memory)
  });

  it('emits pre-provision at 50% RAM', () => {
    const events = [];
    const handler = (e) => events.push(e);
    bus.on('pre-provision', handler);

    checkThresholds(makeContainer(), {
      memory_used: 260 * MB, // ~50.8%
      cpu_percent: 5,
    });

    bus.off('pre-provision', handler);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'pre-provision');
  });

  it('emits migrate at 75% (not pre-provision)', () => {
    const events = [];
    const handler = (e) => events.push(e);
    bus.on('*', handler);

    checkThresholds(makeContainer(), {
      memory_used: 400 * MB, // ~78%
      cpu_percent: 5,
    });

    bus.off('*', handler);
    // Should get migrate, NOT pre-provision (only highest fires)
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'migrate');
  });

  it('emits critical at 95%', () => {
    const events = [];
    const handler = (e) => events.push(e);
    bus.on('*', handler);

    checkThresholds(makeContainer(), {
      memory_used: 490 * MB, // ~95.7%
      cpu_percent: 5,
    });

    bus.off('*', handler);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'critical');
  });

  it('debounces repeated events within 60s', () => {
    const events = [];
    const handler = (e) => events.push(e);
    bus.on('*', handler);

    const container = makeContainer();
    const stats = { memory_used: 400 * MB, cpu_percent: 5 };

    checkThresholds(container, stats);
    checkThresholds(container, stats); // same again immediately

    bus.off('*', handler);
    assert.equal(events.length, 1, 'second call should be debounced');
  });

  it('emits nothing below 50%', () => {
    const events = [];
    const handler = (e) => events.push(e);
    bus.on('*', handler);

    checkThresholds(makeContainer(), {
      memory_used: 200 * MB, // ~39%
      cpu_percent: 5,
    });

    bus.off('*', handler);
    assert.equal(events.length, 0);
  });

  it('emits idle-sleep after idle timeout', () => {
    const events = [];
    const handler = (e) => events.push(e);
    bus.on('idle-sleep', handler);

    const container = makeContainer();

    // First poll with activity to set lastActiveCpu
    checkThresholds(container, { memory_used: 100 * MB, cpu_percent: 5 });

    // Manually backdate the lastActiveCpu
    const s = getState('test-1');
    s.lastActiveCpu = Date.now() - 16 * 60_000; // 16 min ago

    // Now poll with zero CPU
    checkThresholds(container, { memory_used: 100 * MB, cpu_percent: 0 });

    bus.off('idle-sleep', handler);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'idle-sleep');
  });
});
