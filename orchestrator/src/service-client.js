/**
 * HTTP clients for calling Layer 3 services.
 * All methods return parsed JSON or throw on error.
 */

const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const PUBLISH_URL = process.env.PUBLISH_SERVICE_URL || 'http://localhost:3003';

async function request(base, path, opts = {}) {
  const url = `${base}${path}`;
  const { headers: extraHeaders = {}, body, timeout, ...rest } = opts;
  const res = await fetch(url, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    signal: AbortSignal.timeout(timeout || 30000),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const err = new Error(`${opts.method || 'GET'} ${url} → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ── Auth Service ──────────────────────────────────────────────────────

export const authService = {
  health() {
    return request(AUTH_URL, '/health', { timeout: 5000 });
  },

  /** Validate a session token, returns { user } or throws 401. */
  validate(token) {
    return request(AUTH_URL, '/auth/validate', {
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  /** Exchange a GitHub OAuth code for a user + session token. */
  githubAuth(code) {
    return request(AUTH_URL, '/auth/github', {
      method: 'POST',
      body: { code },
    });
  },

  /** Exchange a Google OAuth code for a user + session token. */
  googleAuth(code, redirectUri) {
    return request(AUTH_URL, '/auth/google', {
      method: 'POST',
      body: { code, redirect_uri: redirectUri },
    });
  },

  /** Send a magic login link to the given email. */
  sendMagicLink(email) {
    return request(AUTH_URL, '/auth/email', {
      method: 'POST',
      body: { email },
    });
  },

  /** Verify a magic link token, returns { user, token, expires_at }. */
  verifyMagicLink(token) {
    return request(AUTH_URL, `/auth/email/verify?token=${encodeURIComponent(token)}`);
  },

  /** Log out (invalidate token). */
  logout(token) {
    return request(AUTH_URL, '/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  /** Delete current authenticated account. */
  deleteAccount(token) {
    return request(AUTH_URL, '/auth/account', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  // ── Shares ──────────────────────────────────────────────────────────

  /** Create a share. */
  createShare(token, body) {
    return request(AUTH_URL, '/shares', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
  },

  /** List shares owned by the authenticated user. */
  listShares(token) {
    return request(AUTH_URL, '/shares', {
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  /** Get a single share by ID (owner only). */
  getShare(token, shareId) {
    return request(AUTH_URL, `/shares/${shareId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  /** Update a share (owner only). */
  updateShare(token, shareId, body) {
    return request(AUTH_URL, `/shares/${shareId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      body,
    });
  },

  /** Delete a share (owner only). */
  deleteShare(token, shareId) {
    return request(AUTH_URL, `/shares/${shareId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  /** Look up a share by its public token. */
  getShareByToken(token) {
    return request(AUTH_URL, `/shares/by-token/${token}`);
  },

  /** Join a share (authenticated user). */
  joinShare(sessionToken, shareToken) {
    return request(AUTH_URL, `/shares/join/${shareToken}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
  },

  /** List shares the authenticated user has joined. */
  listSharedWithMe(token) {
    return request(AUTH_URL, '/shares/shared-with-me', {
      headers: { Authorization: `Bearer ${token}` },
    });
  },

  /** Check if a user has share-based access to a document (internal). */
  checkShareAccess({ userId, ownerId, project, docPath }) {
    const params = new URLSearchParams();
    if (userId) params.set('userId', userId);
    params.set('ownerId', ownerId);
    params.set('project', project);
    if (docPath) params.set('docPath', docPath);
    return request(AUTH_URL, `/shares/check-access?${params.toString()}`);
  },
};

// ── Publish Service ───────────────────────────────────────────────────

export const publishService = {
  health() {
    // publish-service has no /health, just check if it responds
    return request(PUBLISH_URL, '/@_healthcheck/_test', { timeout: 5000 })
      .then(() => ({ status: 'ok' }))
      .catch(() => ({ status: 'ok' })); // 404 is fine, means the service is up
  },
};

// ── Sync Relay ────────────────────────────────────────────────────────

const SYNC_RELAY_URL = process.env.SYNC_RELAY_URL || `http://localhost:${process.env.SYNC_RELAY_PORT || '3006'}`;

export const syncRelay = {
  health() {
    return request(SYNC_RELAY_URL, '/health', { timeout: 5000 });
  },

  stats() {
    return request(SYNC_RELAY_URL, '/stats', { timeout: 5000 });
  },

  listDocuments(userId) {
    return request(SYNC_RELAY_URL, `/api/documents/${userId}`, { timeout: 10000 });
  },

  listProjectDocuments(userId, project) {
    return request(SYNC_RELAY_URL, `/api/documents/${userId}/${project}`, { timeout: 10000 });
  },
};
