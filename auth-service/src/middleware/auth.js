const pool = require('../db');

/**
 * Express middleware: extracts session token from Authorization header,
 * cookie, or query param. Looks up the session, attaches req.user.
 * Responds 401 if invalid/expired.
 */
async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const { rows } = await pool.query(
      `SELECT s.id AS session_id, s.expires_at, u.*
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    req.user = rows[0];
    req.sessionToken = token;
    next();
  } catch (err) {
    console.error('Auth middleware error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

function extractToken(req) {
  // Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Cookie
  if (req.cookies && req.cookies.session_token) {
    return req.cookies.session_token;
  }
  // Query param
  if (req.query.token) {
    return req.query.token;
  }
  return null;
}

module.exports = { requireAuth, extractToken };
