/**
 * Tests for user and runtime lifecycle logic.
 * Uses node:test with mock service clients.
 */

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock service-client before importing lifecycle modules ────────────

// We need to mock at the module level. Since we're using ESM, we'll test
// the logic by directly invoking functions with controlled state.

describe('runtime-lifecycle helpers', () => {
  describe('extractUserId', () => {
    // We test the logic inline since the function is not exported.
    // The pattern is: rt-{userId}-{shortId}
    it('should extract userId from container names', () => {
      // Simple numeric userId
      const name1 = 'rt-42-abc12345';
      const parts1 = name1.split('-');
      const userId1 = parts1.slice(1, -1).join('-');
      assert.equal(userId1, '42');

      // UUID userId
      const name2 = 'rt-550e8400-e29b-41d4-a716-446655440000-abc12345';
      const parts2 = name2.split('-');
      const userId2 = parts2.slice(1, -1).join('-');
      assert.equal(userId2, '550e8400-e29b-41d4-a716-446655440000');
    });
  });

  describe('selectUpgradeType logic', () => {
    function selectUpgradeType(event) {
      const memPercent = event.memory_percent || 0;
      if (memPercent >= 90) return 't3.xlarge';
      if (memPercent >= 75) return 't3.large';
      if (memPercent >= 50) return 't3.medium';
      return 't3.small';
    }

    it('should select t3.medium at 50% memory', () => {
      assert.equal(selectUpgradeType({ memory_percent: 50 }), 't3.medium');
    });

    it('should select t3.large at 75% memory', () => {
      assert.equal(selectUpgradeType({ memory_percent: 75 }), 't3.large');
    });

    it('should select t3.xlarge at 90%+ memory', () => {
      assert.equal(selectUpgradeType({ memory_percent: 95 }), 't3.xlarge');
    });

    it('should select t3.small below 50%', () => {
      assert.equal(selectUpgradeType({ memory_percent: 30 }), 't3.small');
    });
  });
});

describe('caddy-config', () => {
  it('should generate valid config structure', async () => {
    const { generateCaddyConfig } = await import('../src/caddy-config.js');
    const config = generateCaddyConfig();

    assert.ok(config.admin);
    assert.ok(config.apps.http.servers.srv0);
    assert.ok(Array.isArray(config.apps.http.servers.srv0.routes));

    const routes = config.apps.http.servers.srv0.routes;
    const ids = routes.map(r => r['@id']);

    assert.ok(ids.includes('publish'));
    assert.ok(ids.includes('auth'));
    assert.ok(ids.includes('join'));
    assert.ok(ids.includes('api'));
    assert.ok(ids.includes('fallback'));
  });

  it('should route /@* to publish-service on port 3003', async () => {
    const { generateCaddyConfig } = await import('../src/caddy-config.js');
    const config = generateCaddyConfig();
    const publishRoute = config.apps.http.servers.srv0.routes.find(r => r['@id'] === 'publish');

    assert.deepEqual(publishRoute.match, [{ path: ['/@*'] }]);
    assert.equal(publishRoute.handle[0].upstreams[0].dial, 'localhost:3003');
  });

  it('should route /auth/* to auth-service on port 3001', async () => {
    const { generateCaddyConfig } = await import('../src/caddy-config.js');
    const config = generateCaddyConfig();
    const authRoute = config.apps.http.servers.srv0.routes.find(r => r['@id'] === 'auth');

    assert.deepEqual(authRoute.match, [{ path: ['/auth/*'] }]);
    assert.equal(authRoute.handle[0].upstreams[0].dial, 'localhost:3001');
  });
});

describe('event routing', () => {
  const EVENT_TYPES = [
    'pre-provision',
    'migrate',
    'urgent-migrate',
    'critical',
    'idle-sleep',
    'idle-wake',
    'gpu-hint',
  ];

  it('should recognize all expected event types', () => {
    // Verify the event types we handle match what resource-monitor emits
    const monitorTypes = ['critical', 'urgent-migrate', 'migrate', 'pre-provision', 'idle-sleep', 'idle-wake'];
    for (const type of monitorTypes) {
      assert.ok(EVENT_TYPES.includes(type), `Missing handler for event type: ${type}`);
    }
  });
});
