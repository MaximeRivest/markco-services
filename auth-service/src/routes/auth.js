const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

const SESSION_TTL_DAYS = 30;

function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function normalizeUsername(input) {
  const raw = String(input || '').trim().toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');

  let username = cleaned || 'user';
  if (!/^[a-z_]/.test(username)) {
    username = `u_${username}`;
  }

  // Keep Linux-friendly length (common max is 32 chars)
  return username.slice(0, 32);
}

async function ensureUniqueUsername(baseUsername, existingUserId = null) {
  const base = normalizeUsername(baseUsername);

  for (let i = 0; i < 500; i++) {
    const suffix = i === 0 ? '' : `_${i + 1}`;
    const maxBaseLen = 32 - suffix.length;
    const candidate = `${base.slice(0, Math.max(1, maxBaseLen))}${suffix}`;

    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1 LIMIT 1', [candidate]);
    if (rows.length === 0) return candidate;
    if (existingUserId && rows[0].id === existingUserId) return candidate;
  }

  // Extremely unlikely fallback
  return `u_${crypto.randomBytes(6).toString('hex').slice(0, 12)}`;
}

async function createSession(userId) {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await pool.query(
    'INSERT INTO sessions (user_id, token, expires_at) VALUES ($1, $2, $3)',
    [userId, token, expiresAt]
  );
  return { token, expiresAt };
}

/**
 * Upsert a user by provider ID, returning the user row.
 */
async function upsertUser({ email, name, avatarUrl, githubId, googleId, usernameCandidate }) {
  const idCol = githubId ? 'github_id' : 'google_id';
  const idVal = githubId || googleId;

  // Try to find existing user by provider ID
  const existing = await pool.query(
    `SELECT * FROM users WHERE ${idCol} = $1`, [idVal]
  );
  if (existing.rows.length > 0) {
    const existingUser = existing.rows[0];
    const resolvedUsername = existingUser.username || await ensureUniqueUsername(usernameCandidate || email.split('@')[0], existingUser.id);

    // Update name/avatar on each login + backfill username if missing
    const { rows } = await pool.query(
      `UPDATE users
       SET name = COALESCE($1, name),
           avatar_url = COALESCE($2, avatar_url),
           username = COALESCE(username, $3)
       WHERE ${idCol} = $4 RETURNING *`,
      [name, avatarUrl, resolvedUsername, idVal]
    );
    return rows[0];
  }

  // Try to find by email and link the provider
  const byEmail = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  if (byEmail.rows.length > 0) {
    const existingUser = byEmail.rows[0];
    const resolvedUsername = existingUser.username || await ensureUniqueUsername(usernameCandidate || email.split('@')[0], existingUser.id);

    const { rows } = await pool.query(
      `UPDATE users
       SET ${idCol} = $1,
           name = COALESCE($2, name),
           avatar_url = COALESCE($3, avatar_url),
           username = COALESCE(username, $4)
       WHERE email = $5 RETURNING *`,
      [idVal, name, avatarUrl, resolvedUsername, email]
    );
    return rows[0];
  }

  // Create new user
  const resolvedUsername = await ensureUniqueUsername(usernameCandidate || email.split('@')[0]);
  const { rows } = await pool.query(
    `INSERT INTO users (email, username, name, avatar_url, ${idCol})
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [email, resolvedUsername, name, avatarUrl, idVal]
  );
  return rows[0];
}

// ── POST /auth/github ──────────────────────────────────────────────
router.post('/auth/github', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Missing code' });
  }

  try {
    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });
    const tokenText = await tokenRes.text();
    let tokenData;
    try {
      tokenData = JSON.parse(tokenText);
    } catch {
      console.error('GitHub returned non-JSON:', tokenText.substring(0, 200));
      return res.status(502).json({ error: 'GitHub OAuth failed', detail: 'Invalid response from GitHub' });
    }

    if (tokenData.error) {
      return res.status(401).json({ error: 'GitHub OAuth failed', detail: tokenData.error_description });
    }

    // Fetch user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const ghUser = await userRes.json();

    // Fetch primary email if not public
    let email = ghUser.email;
    if (!email) {
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const emails = await emailsRes.json();
      const primary = emails.find(e => e.primary) || emails[0];
      email = primary?.email;
    }

    if (!email) {
      return res.status(400).json({ error: 'Could not retrieve email from GitHub' });
    }

    const user = await upsertUser({
      email,
      name: ghUser.name || ghUser.login,
      avatarUrl: ghUser.avatar_url,
      githubId: String(ghUser.id),
      usernameCandidate: ghUser.login || email.split('@')[0],
    });

    const session = await createSession(user.id);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        avatar_url: user.avatar_url,
        plan: user.plan,
      },
      token: session.token,
      expires_at: session.expiresAt,
    });
  } catch (err) {
    console.error('GitHub auth error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/google ──────────────────────────────────────────────
router.post('/auth/google', async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Missing code' });
  }

  // Stub: in production, exchange code via Google OAuth2 token endpoint
  // For now, return a descriptive error
  res.status(501).json({ error: 'Google OAuth not yet implemented' });
});

// ── GET /auth/validate ─────────────────────────────────────────────
router.get('/auth/validate', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    user: {
      id: u.id,
      email: u.email,
      username: u.username,
      name: u.name,
      avatar_url: u.avatar_url,
      plan: u.plan,
    },
  });
});

// ── POST /auth/logout ──────────────────────────────────────────────
router.post('/auth/logout', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM sessions WHERE token = $1', [req.sessionToken]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Logout error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
