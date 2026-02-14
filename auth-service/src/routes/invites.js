const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = Router();

const VALID_ROLES = ['viewer', 'editor', 'admin'];

// ── POST /invites ──────────────────────────────────────────────────
router.post('/invites', requireAuth, async (req, res) => {
  const { project, role = 'editor', expires_in_days } = req.body;

  if (!project) {
    return res.status(400).json({ error: 'Missing project' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` });
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = expires_in_days
    ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000)
    : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO invites (project_path, token, role, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [project, token, role, expiresAt, req.user.id]
    );

    res.status(201).json({
      token: rows[0].token,
      project: rows[0].project_path,
      role: rows[0].role,
      expires_at: rows[0].expires_at,
    });
  } catch (err) {
    console.error('Create invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /invites/:token ────────────────────────────────────────────
router.get('/invites/:token', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.name AS created_by_name
       FROM invites i LEFT JOIN users u ON i.created_by = u.id
       WHERE i.token = $1`,
      [req.params.token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    const invite = rows[0];
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      return res.status(410).json({ error: 'Invite expired' });
    }

    res.json({
      project: invite.project_path,
      role: invite.role,
      created_by: invite.created_by_name,
      expires_at: invite.expires_at,
    });
  } catch (err) {
    console.error('Get invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /invites/:token ─────────────────────────────────────────
router.delete('/invites/:token', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      'DELETE FROM invites WHERE token = $1 AND created_by = $2',
      [req.params.token, req.user.id]
    );

    if (rowCount === 0) {
      return res.status(404).json({ error: 'Invite not found or not owned by you' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete invite error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
