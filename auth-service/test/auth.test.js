const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const pool = require('../src/db');

// We import the app without starting the server
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const authRoutes = require('../src/routes/auth');
const inviteRoutes = require('../src/routes/invites');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(authRoutes);
app.use(inviteRoutes);

let server;
let baseUrl;

function request(method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const opts = { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { ...headers } };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('auth-service', () => {
  before(async () => {
    // Apply schema
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8');
    await pool.query(schema);

    server = app.listen(0);
    await new Promise(r => server.on('listening', r));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    server.close();
    await pool.end();
  });

  beforeEach(async () => {
    // Clean tables between tests
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM invites');
    await pool.query('DELETE FROM users');
  });

  // ── Helper: create a user + session directly ──
  async function seedUser() {
    const crypto = require('crypto');
    const { rows: [user] } = await pool.query(
      `INSERT INTO users (email, name, github_id) VALUES ('test@example.com', 'Test User', '12345') RETURNING *`
    );
    const token = crypto.randomBytes(32).toString('base64url');
    await pool.query(
      `INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
      [user.id, token]
    );
    return { user, token };
  }

  describe('POST /auth/github', () => {
    it('returns 400 without code', async () => {
      const res = await request('POST', '/auth/github', { body: {} });
      assert.equal(res.status, 400);
    });
  });

  describe('GET /auth/validate', () => {
    it('returns 401 without token', async () => {
      const res = await request('GET', '/auth/validate');
      assert.equal(res.status, 401);
    });

    it('returns 401 with invalid token', async () => {
      const res = await request('GET', '/auth/validate', {
        headers: { Authorization: 'Bearer invalid-token' },
      });
      assert.equal(res.status, 401);
    });

    it('returns user with valid token', async () => {
      const { user, token } = await seedUser();
      const res = await request('GET', '/auth/validate', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.email, 'test@example.com');
      assert.equal(res.body.user.id, user.id);
    });
  });

  describe('POST /auth/logout', () => {
    it('invalidates session', async () => {
      const { token } = await seedUser();
      const res = await request('POST', '/auth/logout', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);

      // Token should no longer work
      const res2 = await request('GET', '/auth/validate', {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res2.status, 401);
    });
  });

  describe('Invites', () => {
    it('requires auth to create invite', async () => {
      const res = await request('POST', '/invites', { body: { project: '/test' } });
      assert.equal(res.status, 401);
    });

    it('creates, retrieves, and deletes an invite', async () => {
      const { token } = await seedUser();

      // Create
      const create = await request('POST', '/invites', {
        body: { project: '/user/project', role: 'editor' },
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(create.status, 201);
      assert.equal(create.body.project, '/user/project');
      assert.equal(create.body.role, 'editor');
      const inviteToken = create.body.token;

      // Retrieve (no auth needed)
      const get = await request('GET', `/invites/${inviteToken}`);
      assert.equal(get.status, 200);
      assert.equal(get.body.project, '/user/project');

      // Delete
      const del = await request('DELETE', `/invites/${inviteToken}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(del.status, 200);

      // Should be gone
      const get2 = await request('GET', `/invites/${inviteToken}`);
      assert.equal(get2.status, 404);
    });

    it('rejects invalid role', async () => {
      const { token } = await seedUser();
      const res = await request('POST', '/invites', {
        body: { project: '/test', role: 'superadmin' },
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(res.status, 400);
    });
  });
});
