/**
 * Quick smoke test for the shares API.
 * Run: node test/shares.test.js
 *
 * Requires a local PostgreSQL with the markco database.
 * This test creates a temporary user, runs through the share lifecycle, and cleans up.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const pool = require('../src/db');

const BASE = 'http://localhost:3001';

let testUser = null;
let testSession = null;
let testUser2 = null;
let testSession2 = null;

async function createTestUser(suffix = '') {
  const email = `test-shares-${Date.now()}${suffix}@example.com`;
  const username = `test_shares_${Date.now()}${suffix}`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, username, name) VALUES ($1, $2, $3) RETURNING *`,
    [email, username, `Test User${suffix}`]
  );
  const user = rows[0];

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [user.id, token, expiresAt]
  );

  return { user, token };
}

async function cleanup() {
  if (testUser?.id) {
    await pool.query('DELETE FROM share_members WHERE user_id = $1', [testUser.id]);
    await pool.query('DELETE FROM shares WHERE owner_id = $1', [testUser.id]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [testUser.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUser.id]);
  }
  if (testUser2?.id) {
    await pool.query('DELETE FROM share_members WHERE user_id = $1', [testUser2.id]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [testUser2.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUser2.id]);
  }
}

describe('Shares API', async () => {
  before(async () => {
    // Apply schema
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8');
    await pool.query(schema);

    // Create test users
    const u1 = await createTestUser('');
    testUser = u1.user;
    testSession = u1.token;

    const u2 = await createTestUser('_collaborator');
    testUser2 = u2.user;
    testSession2 = u2.token;
  });

  after(async () => {
    await cleanup();
    await pool.end();
  });

  let shareId = null;
  let shareToken = null;

  test('POST /shares — create a share', async () => {
    const res = await fetch(`${BASE}/shares`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testSession}`,
      },
      body: JSON.stringify({
        project: 'test-project',
        docPath: '01-intro',
        role: 'editor',
        requireAuth: true,
        label: 'Test share',
      }),
    });

    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.ok(data.id);
    assert.ok(data.token);
    assert.ok(data.shareUrl);
    assert.strictEqual(data.project, 'test-project');
    assert.strictEqual(data.docPath, '01-intro');
    assert.strictEqual(data.role, 'editor');
    assert.strictEqual(data.active, true);

    shareId = data.id;
    shareToken = data.token;
  });

  test('GET /shares — list my shares', async () => {
    const res = await fetch(`${BASE}/shares`, {
      headers: { Authorization: `Bearer ${testSession}` },
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.shares));
    assert.ok(data.shares.length >= 1);

    const found = data.shares.find(s => s.id === shareId);
    assert.ok(found);
    assert.strictEqual(found.project, 'test-project');
    assert.deepStrictEqual(found.members, []);
  });

  test('GET /shares/by-token/:token — public lookup', async () => {
    const res = await fetch(`${BASE}/shares/by-token/${shareToken}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.id, shareId);
    assert.ok(data.owner);
    assert.strictEqual(data.owner.id, testUser.id);
  });

  test('POST /shares/join/:token — collaborator joins', async () => {
    const res = await fetch(`${BASE}/shares/join/${shareToken}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testSession2}` },
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.shareId, shareId);
    assert.strictEqual(data.project, 'test-project');
  });

  test('GET /shares — members appear after join', async () => {
    const res = await fetch(`${BASE}/shares`, {
      headers: { Authorization: `Bearer ${testSession}` },
    });

    const data = await res.json();
    const found = data.shares.find(s => s.id === shareId);
    assert.ok(found);
    assert.strictEqual(found.members.length, 1);
    assert.strictEqual(found.members[0].userId, testUser2.id);
  });

  test('GET /shares/shared-with-me — collaborator sees share', async () => {
    const res = await fetch(`${BASE}/shares/shared-with-me`, {
      headers: { Authorization: `Bearer ${testSession2}` },
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.shares.length >= 1);
    const found = data.shares.find(s => s.id === shareId);
    assert.ok(found);
    assert.strictEqual(found.owner.id, testUser.id);
  });

  test('GET /shares/check-access — collaborator has access', async () => {
    const params = new URLSearchParams({
      userId: testUser2.id,
      ownerId: testUser.id,
      project: 'test-project',
      docPath: '01-intro',
    });
    const res = await fetch(`${BASE}/shares/check-access?${params}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.allowed, true);
    assert.strictEqual(data.role, 'editor');
  });

  test('GET /shares/check-access — random user denied', async () => {
    const params = new URLSearchParams({
      userId: '00000000-0000-0000-0000-000000000000',
      ownerId: testUser.id,
      project: 'test-project',
      docPath: '01-intro',
    });
    const res = await fetch(`${BASE}/shares/check-access?${params}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.allowed, false);
  });

  test('PATCH /shares/:id — pause share', async () => {
    const res = await fetch(`${BASE}/shares/${shareId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testSession}`,
      },
      body: JSON.stringify({ active: false }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.active, false);
  });

  test('GET /shares/check-access — denied when paused', async () => {
    const params = new URLSearchParams({
      userId: testUser2.id,
      ownerId: testUser.id,
      project: 'test-project',
      docPath: '01-intro',
    });
    const res = await fetch(`${BASE}/shares/check-access?${params}`);
    const data = await res.json();
    assert.strictEqual(data.allowed, false);
  });

  test('PATCH /shares/:id — resume share', async () => {
    const res = await fetch(`${BASE}/shares/${shareId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testSession}`,
      },
      body: JSON.stringify({ active: true }),
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.active, true);
  });

  test('DELETE /shares/:id — delete share', async () => {
    const res = await fetch(`${BASE}/shares/${shareId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testSession}` },
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
  });

  test('GET /shares/check-access — denied after deletion', async () => {
    const params = new URLSearchParams({
      userId: testUser2.id,
      ownerId: testUser.id,
      project: 'test-project',
      docPath: '01-intro',
    });
    const res = await fetch(`${BASE}/shares/check-access?${params}`);
    const data = await res.json();
    assert.strictEqual(data.allowed, false);
  });

  // ── Open share (no auth required) ──────────────────────────────────

  let openShareId = null;
  let openShareToken = null;

  test('POST /shares — create open share (no auth required)', async () => {
    const res = await fetch(`${BASE}/shares`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${testSession}`,
      },
      body: JSON.stringify({
        project: 'open-project',
        docPath: 'readme',
        role: 'viewer',
        requireAuth: false,
      }),
    });

    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.strictEqual(data.requireAuth, false);
    assert.strictEqual(data.role, 'viewer');
    openShareId = data.id;
    openShareToken = data.token;
  });

  test('GET /shares/check-access — open share allows anonymous', async () => {
    const params = new URLSearchParams({
      ownerId: testUser.id,
      project: 'open-project',
      docPath: 'readme',
    });
    const res = await fetch(`${BASE}/shares/check-access?${params}`);
    const data = await res.json();
    assert.strictEqual(data.allowed, true);
    assert.strictEqual(data.role, 'viewer');
  });

  test('cleanup open share', async () => {
    await fetch(`${BASE}/shares/${openShareId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${testSession}` },
    });
  });
});
