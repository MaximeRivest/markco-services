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
  const { code, redirect_uri: redirectUri } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'Missing code' });
  }

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Google OAuth is not configured' });
  }

  try {
    const tokenParams = new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri || process.env.GOOGLE_REDIRECT_URI || '',
      grant_type: 'authorization_code',
    });

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString(),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || tokenData.error) {
      return res.status(401).json({
        error: 'Google OAuth failed',
        detail: tokenData.error_description || tokenData.error || `HTTP ${tokenRes.status}`,
      });
    }

    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const googleUser = await userRes.json();

    if (!userRes.ok) {
      return res.status(401).json({ error: 'Google user lookup failed', detail: googleUser.error || `HTTP ${userRes.status}` });
    }

    const email = googleUser.email;
    if (!email) {
      return res.status(400).json({ error: 'Could not retrieve email from Google' });
    }

    const user = await upsertUser({
      email,
      name: googleUser.name || email.split('@')[0],
      avatarUrl: googleUser.picture,
      googleId: String(googleUser.sub),
      usernameCandidate: googleUser.given_name || email.split('@')[0],
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
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /auth/email ────────────────────────────────────────────────
// Send a magic login link to the given email address.
router.post('/auth/email', async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Missing email' });
  }

  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  try {
    // Rate limit: max 3 magic links per email per 15 minutes
    const { rows: recent } = await pool.query(
      `SELECT COUNT(*) AS cnt FROM magic_links
       WHERE email = $1 AND created_at > NOW() - INTERVAL '15 minutes'`,
      [normalized]
    );
    if (parseInt(recent[0].cnt, 10) >= 3) {
      return res.status(429).json({ error: 'Too many requests. Check your inbox or try again in a few minutes.' });
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await pool.query(
      'INSERT INTO magic_links (email, token, expires_at) VALUES ($1, $2, $3)',
      [normalized, token, expiresAt]
    );

    // Send email via AWS SES
    const { SESClient, SendEmailCommand } = require('@aws-sdk/client-ses');
    const ses = new SESClient({ region: process.env.AWS_REGION || 'ca-central-1' });

    const verifyUrl = `${process.env.APP_URL || 'https://markco.dev'}/auth/email/verify?token=${token}`;

    await ses.send(new SendEmailCommand({
      Source: 'markco.dev <noreply@markco.dev>',
      Destination: { ToAddresses: [normalized] },
      Message: {
        Subject: { Data: 'Your markco.dev login link' },
        Body: {
          Text: { Data: `Sign in to markco.dev:\n\n${verifyUrl}\n\nThis link expires in 15 minutes. If you didn't request this, you can safely ignore it.` },
          Html: {
            Data: `
              <div style="font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px 0">
                <h2 style="margin:0 0 16px">Sign in to markco.dev</h2>
                <p style="color:#555;line-height:1.5">Click the button below to sign in. This link expires in 15 minutes.</p>
                <a href="${verifyUrl}" style="display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;margin:16px 0;font-weight:500">Sign in to markco.dev</a>
                <p style="color:#999;font-size:13px;margin-top:24px">If you didn't request this email, you can safely ignore it.</p>
                <p style="color:#ccc;font-size:12px;margin-top:32px">markco.dev</p>
              </div>
            `,
          },
        },
      },
    }));

    res.json({ ok: true, message: 'Magic link sent. Check your inbox.' });
  } catch (err) {
    console.error('Magic link error:', err);
    res.status(500).json({ error: 'Failed to send magic link' });
  }
});

// ── GET /auth/email/verify ─────────────────────────────────────────
// Validate a magic link token and return a session (called by orchestrator).
router.get('/auth/email/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  try {
    // Find the magic link (not used, not expired)
    const { rows } = await pool.query(
      `SELECT * FROM magic_links
       WHERE token = $1 AND used = FALSE AND expires_at > NOW()`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired link' });
    }

    const magicLink = rows[0];

    // Mark as used (single-use)
    await pool.query('UPDATE magic_links SET used = TRUE WHERE id = $1', [magicLink.id]);

    // Find or create user by email
    const { rows: existingUsers } = await pool.query(
      'SELECT * FROM users WHERE email = $1', [magicLink.email]
    );

    let user;
    if (existingUsers.length > 0) {
      user = existingUsers[0];
      // Backfill username if missing
      if (!user.username) {
        const username = await ensureUniqueUsername(magicLink.email.split('@')[0], user.id);
        const { rows: updated } = await pool.query(
          'UPDATE users SET username = $1 WHERE id = $2 RETURNING *',
          [username, user.id]
        );
        user = updated[0];
      }
    } else {
      // Create new user
      const username = await ensureUniqueUsername(magicLink.email.split('@')[0]);
      const { rows: created } = await pool.query(
        'INSERT INTO users (email, username, name) VALUES ($1, $2, $3) RETURNING *',
        [magicLink.email, username, magicLink.email.split('@')[0]]
      );
      user = created[0];
    }

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
    console.error('Magic link verify error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
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

// ── DELETE /auth/account ────────────────────────────────────────────
router.delete('/auth/account', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Preserve invites while allowing account deletion.
    await client.query('UPDATE invites SET created_by = NULL WHERE created_by = $1', [userId]);

    // Sessions table also cascades from users, but this keeps intent explicit.
    await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

    const { rowCount } = await client.query('DELETE FROM users WHERE id = $1', [userId]);
    if (rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    await client.query('COMMIT');
    return res.json({ ok: true, deleted_user_id: userId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Delete account error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
