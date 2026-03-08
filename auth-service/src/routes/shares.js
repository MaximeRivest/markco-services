const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

const VALID_ROLES = ['viewer', 'editor'];
const DOMAIN = process.env.DOMAIN || 'markco.dev';
const IS_LOCAL_DOMAIN = /^(\d|localhost)/.test(DOMAIN);

function appProtocol() {
  return IS_LOCAL_DOMAIN ? 'http' : 'https';
}

function shareUrl(token) {
  return `${appProtocol()}://${DOMAIN}/join/${token}`;
}

// ── POST /shares ─────────────────────────────────────────────────────
// Create a new share. Owner only.
router.post('/shares', requireAuth, async (req, res) => {
  const {
    project,
    docPath = null,
    role = 'editor',
    requireAuth: reqAuth = true,
    label = null,
    invitedEmail = null,
    expiresInDays = null,
    maxUses = null,
  } = req.body;

  if (!project || typeof project !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid project' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO shares (owner_id, project, doc_path, token, role, require_auth, active, label, invited_email, expires_at, max_uses)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.id, project, docPath || null, token, role, reqAuth !== false, label, invitedEmail, expiresAt, maxUses]
    );

    const share = rows[0];
    res.status(201).json({
      id: share.id,
      token: share.token,
      shareUrl: shareUrl(share.token),
      project: share.project,
      docPath: share.doc_path,
      role: share.role,
      requireAuth: share.require_auth,
      active: share.active,
      label: share.label,
      invitedEmail: share.invited_email,
      expiresAt: share.expires_at,
      maxUses: share.max_uses,
      createdAt: share.created_at,
    });
  } catch (err) {
    console.error('Create share error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /shares ──────────────────────────────────────────────────────
// List all shares owned by the current user, with member info.
router.get('/shares', requireAuth, async (req, res) => {
  try {
    const { rows: shares } = await pool.query(
      `SELECT s.*,
              COALESCE(
                json_agg(
                  json_build_object(
                    'userId', sm.user_id,
                    'name', u.name,
                    'email', u.email,
                    'avatarUrl', u.avatar_url,
                    'joinedAt', sm.joined_at
                  )
                ) FILTER (WHERE sm.user_id IS NOT NULL),
                '[]'
              ) AS members
       FROM shares s
       LEFT JOIN share_members sm ON sm.share_id = s.id
       LEFT JOIN users u ON u.id = sm.user_id
       WHERE s.owner_id = $1
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
      [req.user.id]
    );

    res.json({
      shares: shares.map(s => ({
        id: s.id,
        project: s.project,
        docPath: s.doc_path,
        role: s.role,
        requireAuth: s.require_auth,
        active: s.active,
        label: s.label,
        invitedEmail: s.invited_email,
        token: s.token,
        shareUrl: shareUrl(s.token),
        expiresAt: s.expires_at,
        maxUses: s.max_uses,
        useCount: s.use_count,
        members: s.members,
        createdAt: s.created_at,
      })),
    });
  } catch (err) {
    console.error('List shares error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /shares/shared-with-me ───────────────────────────────────────
// List shares the current user has joined (as a collaborator).
router.get('/shares/shared-with-me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.project, s.doc_path, s.role, s.active,
              s.label, s.token, s.expires_at, s.created_at,
              u.name AS owner_name, u.email AS owner_email,
              u.avatar_url AS owner_avatar_url, u.id AS owner_id,
              sm.joined_at
       FROM share_members sm
       JOIN shares s ON s.id = sm.share_id
       JOIN users u ON u.id = s.owner_id
       WHERE sm.user_id = $1
         AND s.active = TRUE
         AND (s.expires_at IS NULL OR s.expires_at > NOW())
       ORDER BY sm.joined_at DESC`,
      [req.user.id]
    );

    res.json({
      shares: rows.map(r => ({
        id: r.id,
        project: r.project,
        docPath: r.doc_path,
        role: r.role,
        active: r.active,
        label: r.label,
        shareUrl: shareUrl(r.token),
        expiresAt: r.expires_at,
        owner: {
          id: r.owner_id,
          name: r.owner_name,
          email: r.owner_email,
          avatarUrl: r.owner_avatar_url,
        },
        joinedAt: r.joined_at,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('List shared-with-me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /shares/check-access ─────────────────────────────────────────
// Internal endpoint: sync-relay calls this to check if a user has access
// to a specific document via a share.
// MUST be defined before /shares/:id to avoid being captured by the param route.
// Query: ?userId=X&ownerId=Y&project=Z&docPath=W
router.get('/shares/check-access', async (req, res) => {
  const { userId, ownerId, project, docPath } = req.query;

  if (!ownerId || !project) {
    return res.status(400).json({ error: 'ownerId and project are required' });
  }

  try {
    // If no userId provided, check if there's an open (no-auth) share
    if (!userId) {
      const { rows } = await pool.query(
        `SELECT s.role FROM shares s
         WHERE s.owner_id = $1
           AND s.project = $2
           AND (s.doc_path IS NULL OR s.doc_path = $3)
           AND s.active = TRUE
           AND s.require_auth = FALSE
           AND (s.expires_at IS NULL OR s.expires_at > NOW())
           AND (s.max_uses IS NULL OR s.use_count < s.max_uses)
         LIMIT 1`,
        [ownerId, project, docPath || null]
      );

      return res.json({
        allowed: rows.length > 0,
        role: rows[0]?.role || null,
      });
    }

    // Check if user is a member of any active share for this doc
    const { rows } = await pool.query(
      `SELECT s.role FROM shares s
       LEFT JOIN share_members sm ON sm.share_id = s.id AND sm.user_id = $1
       WHERE s.owner_id = $2
         AND s.project = $3
         AND (s.doc_path IS NULL OR s.doc_path = $4)
         AND s.active = TRUE
         AND (s.expires_at IS NULL OR s.expires_at > NOW())
         AND (s.max_uses IS NULL OR s.use_count < s.max_uses)
         AND (
           s.require_auth = FALSE
           OR sm.user_id IS NOT NULL
         )
       LIMIT 1`,
      [userId, ownerId, project, docPath || null]
    );

    res.json({
      allowed: rows.length > 0,
      role: rows[0]?.role || null,
    });
  } catch (err) {
    console.error('Check share access error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /shares/:id ──────────────────────────────────────────────────
// Get a single share's details (owner only).
router.get('/shares/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM shares WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Share not found' });
    }

    const share = rows[0];

    // Get members
    const { rows: members } = await pool.query(
      `SELECT sm.user_id, sm.joined_at, u.name, u.email, u.avatar_url
       FROM share_members sm
       JOIN users u ON u.id = sm.user_id
       WHERE sm.share_id = $1
       ORDER BY sm.joined_at`,
      [share.id]
    );

    res.json({
      id: share.id,
      project: share.project,
      docPath: share.doc_path,
      role: share.role,
      requireAuth: share.require_auth,
      active: share.active,
      label: share.label,
      invitedEmail: share.invited_email,
      token: share.token,
      shareUrl: shareUrl(share.token),
      expiresAt: share.expires_at,
      maxUses: share.max_uses,
      useCount: share.use_count,
      members: members.map(m => ({
        userId: m.user_id,
        name: m.name,
        email: m.email,
        avatarUrl: m.avatar_url,
        joinedAt: m.joined_at,
      })),
      createdAt: share.created_at,
    });
  } catch (err) {
    console.error('Get share error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /shares/:id ────────────────────────────────────────────────
// Update a share (owner only). Supports toggling active, changing role, etc.
router.patch('/shares/:id', requireAuth, async (req, res) => {
  const { active, role, requireAuth: reqAuth, label, expiresInDays, maxUses } = req.body;

  if (role !== undefined && !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
  }

  try {
    // Verify ownership
    const { rows: existing } = await pool.query(
      'SELECT * FROM shares WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Share not found' });
    }

    const updates = [];
    const values = [];
    let idx = 1;

    if (active !== undefined) {
      updates.push(`active = $${idx++}`);
      values.push(active);
    }
    if (role !== undefined) {
      updates.push(`role = $${idx++}`);
      values.push(role);
    }
    if (reqAuth !== undefined) {
      updates.push(`require_auth = $${idx++}`);
      values.push(reqAuth);
    }
    if (label !== undefined) {
      updates.push(`label = $${idx++}`);
      values.push(label);
    }
    if (expiresInDays !== undefined) {
      updates.push(`expires_at = $${idx++}`);
      values.push(expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null);
    }
    if (maxUses !== undefined) {
      updates.push(`max_uses = $${idx++}`);
      values.push(maxUses);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    values.push(req.params.id);
    values.push(req.user.id);

    const { rows } = await pool.query(
      `UPDATE shares SET ${updates.join(', ')} WHERE id = $${idx++} AND owner_id = $${idx} RETURNING *`,
      values
    );

    const share = rows[0];
    res.json({
      id: share.id,
      project: share.project,
      docPath: share.doc_path,
      role: share.role,
      requireAuth: share.require_auth,
      active: share.active,
      label: share.label,
      shareUrl: shareUrl(share.token),
      expiresAt: share.expires_at,
      maxUses: share.max_uses,
      useCount: share.use_count,
    });
  } catch (err) {
    console.error('Update share error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /shares/:id ───────────────────────────────────────────────
// Permanently delete a share (owner only). Cascades to share_members.
router.delete('/shares/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM shares WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Share not found or not owned by you' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete share error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /shares/by-token/:token ──────────────────────────────────────
// Look up a share by token (public — used by join page).
// Returns share info + owner info. Does NOT require auth.
router.get('/shares/by-token/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.project, s.doc_path, s.role, s.require_auth,
              s.active, s.label, s.expires_at, s.max_uses, s.use_count,
              s.owner_id, s.created_at,
              u.name AS owner_name, u.username AS owner_username,
              u.avatar_url AS owner_avatar_url
       FROM shares s
       JOIN users u ON u.id = s.owner_id
       WHERE s.token = $1`,
      [req.params.token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Share not found' });
    }

    const share = rows[0];

    // Check expiry
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      return res.status(410).json({ error: 'This share link has expired' });
    }

    // Check max uses
    if (share.max_uses !== null && share.use_count >= share.max_uses) {
      return res.status(410).json({ error: 'This share link has reached its usage limit' });
    }

    // Check active
    if (!share.active) {
      return res.status(403).json({ error: 'This share is currently paused by the owner' });
    }

    res.json({
      id: share.id,
      project: share.project,
      docPath: share.doc_path,
      role: share.role,
      requireAuth: share.require_auth,
      active: share.active,
      label: share.label,
      owner: {
        id: share.owner_id,
        name: share.owner_name,
        username: share.owner_username,
        avatarUrl: share.owner_avatar_url,
      },
      expiresAt: share.expires_at,
      createdAt: share.created_at,
    });
  } catch (err) {
    console.error('Get share by token error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /shares/join/:token ─────────────────────────────────────────
// Join a share (accept it). Requires auth.
// Records the user as a member and increments use_count.
router.post('/shares/join/:token', requireAuth, async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT * FROM shares WHERE token = $1`,
      [req.params.token]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Share not found' });
    }

    const share = rows[0];

    // Validations
    if (!share.active) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This share is currently paused' });
    }
    if (share.expires_at && new Date(share.expires_at) < new Date()) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This share link has expired' });
    }
    if (share.max_uses !== null && share.use_count >= share.max_uses) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'This share link has reached its usage limit' });
    }

    // Owner can't join their own share
    if (share.owner_id === req.user.id) {
      await client.query('ROLLBACK');
      return res.json({
        ok: true,
        alreadyOwner: true,
        shareId: share.id,
      });
    }

    // Upsert member (idempotent — joining twice is fine)
    const insertResult = await client.query(
      `INSERT INTO share_members (share_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (share_id, user_id) DO NOTHING
       RETURNING id`,
      [share.id, req.user.id]
    );

    // Increment use count only on first successful join for this user.
    if (insertResult.rows.length > 0) {
      await client.query(
        'UPDATE shares SET use_count = use_count + 1 WHERE id = $1',
        [share.id]
      );
    }

    await client.query('COMMIT');

    // Get owner info for the response
    const { rows: ownerRows } = await pool.query(
      'SELECT id, name, username, avatar_url FROM users WHERE id = $1',
      [share.owner_id]
    );
    const owner = ownerRows[0] || {};

    res.json({
      ok: true,
      shareId: share.id,
      project: share.project,
      docPath: share.doc_path,
      role: share.role,
      owner: {
        id: owner.id,
        name: owner.name,
        username: owner.username,
        avatarUrl: owner.avatar_url,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Join share error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
