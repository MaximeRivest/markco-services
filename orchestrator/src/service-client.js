/**
 * HTTP clients for calling Layer 3 services.
 * All methods return parsed JSON or throw on error.
 */

const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const COMPUTE_URL = process.env.COMPUTE_MANAGER_URL || 'http://localhost:3002';
const PUBLISH_URL = process.env.PUBLISH_SERVICE_URL || 'http://localhost:3003';
const MONITOR_URL = process.env.RESOURCE_MONITOR_URL || 'http://localhost:3004';

async function request(base, path, opts = {}) {
  const url = `${base}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    signal: AbortSignal.timeout(opts.timeout || 30000),
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
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
};

// ── Compute Manager ───────────────────────────────────────────────────

export const computeManager = {
  health() {
    return request(COMPUTE_URL, '/health', { timeout: 5000 });
  },

  /** Start a runtime container for a user. */
  startRuntime(userId, plan = 'free', language = 'python') {
    return request(COMPUTE_URL, '/runtimes', {
      method: 'POST',
      body: { user_id: userId, plan, language },
    });
  },

  /** Get a user's running runtime info. */
  getRuntime(userId) {
    return request(COMPUTE_URL, `/runtimes/${userId}`);
  },

  /** Stop and remove a user's runtime. */
  stopRuntime(userId) {
    return request(COMPUTE_URL, `/runtimes/${userId}`, { method: 'DELETE' });
  },

  /** Migrate a runtime to a different instance type. */
  migrate(userId, targetType) {
    return request(COMPUTE_URL, `/runtimes/${userId}/migrate`, {
      method: 'POST',
      body: { target_type: targetType },
    });
  },

  /** Create a CRIU snapshot. */
  snapshot(userId, name) {
    return request(COMPUTE_URL, `/runtimes/${userId}/snapshot`, {
      method: 'POST',
      body: { name },
    });
  },

  /** Restore from a CRIU snapshot. */
  restore(userId, snapshotId) {
    return request(COMPUTE_URL, `/runtimes/${userId}/restore`, {
      method: 'POST',
      body: { snapshot_id: snapshotId },
    });
  },
};

// ── Resource Monitor ──────────────────────────────────────────────────

export const resourceMonitor = {
  health() {
    return request(MONITOR_URL, '/health', { timeout: 5000 });
  },

  /** Get all monitored containers and their latest stats. */
  status() {
    return request(MONITOR_URL, '/status');
  },

  /** Register a container for monitoring. */
  register(runtimeId, containerName, host = 'localhost', memoryLimit = 0) {
    return request(MONITOR_URL, '/monitor', {
      method: 'POST',
      body: { runtime_id: runtimeId, container_name: containerName, host, memory_limit: memoryLimit },
    });
  },

  /** Unregister a container from monitoring. */
  unregister(runtimeId) {
    return request(MONITOR_URL, `/monitor/${runtimeId}`, { method: 'DELETE' });
  },

  /** Register a webhook URL for events. */
  registerWebhook(url) {
    return request(MONITOR_URL, '/events/webhook', {
      method: 'POST',
      body: { url },
    });
  },

  /** Get recent events (ring buffer). */
  recentEvents() {
    return request(MONITOR_URL, '/events/recent');
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
