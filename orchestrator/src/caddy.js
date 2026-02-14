/**
 * Caddy admin API wrapper.
 * Caddy's admin API runs on localhost:2019 by default.
 * We use the /config/ endpoint to manage routes dynamically.
 */

const CADDY_ADMIN = process.env.CADDY_ADMIN_URL || 'http://localhost:2019';

async function caddyRequest(path, opts = {}) {
  const url = `${CADDY_ADMIN}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    signal: AbortSignal.timeout(opts.timeout || 10000),
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 200 || res.status === 201) {
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  }
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Caddy ${opts.method || 'GET'} ${path} → ${res.status}: ${text}`);
    err.status = res.status;
    throw err;
  }
  return null;
}

/**
 * Add a reverse proxy route to Caddy.
 * @param {string} id - Unique route identifier (e.g. "user-abc123")
 * @param {string[]} match - Path matchers (e.g. ["/u/abc123/*"])
 * @param {string} upstream - Upstream address (e.g. "localhost:48001")
 * @param {string} [stripPrefix] - Optional path prefix to strip (e.g. "/u/abc123")
 */
export async function addRoute(id, match, upstream, stripPrefix) {
  const handlers = [];

  // Strip prefix before forwarding (so /u/{userId}/foo → /foo on the upstream)
  if (stripPrefix) {
    handlers.push({
      handler: 'rewrite',
      strip_path_prefix: stripPrefix,
    });
  }

  handlers.push({
    handler: 'reverse_proxy',
    upstreams: [{ dial: upstream }],
  });

  const route = {
    '@id': id,
    match: [{ path: match }],
    handle: handlers,
  };

  // Add route to Caddy. Note: for user editor routes, the orchestrator
  // handles proxying internally, so this is mainly for non-user routes.
  try {
    await caddyRequest(`/config/apps/http/servers/srv0/routes`, {
      method: 'POST',
      body: route,
    });
    console.log(`[caddy] Added route ${id} → ${upstream} for ${match.join(', ')}`);
  } catch (err) {
    // If route with this ID already exists, update it
    if (err.status === 500 && err.message.includes('already exists')) {
      await removeRoute(id);
      await addRoute(id, match, upstream);
      return;
    }
    throw err;
  }
}

/**
 * Remove a route by its @id.
 */
export async function removeRoute(id) {
  try {
    await caddyRequest(`/id/${id}`, { method: 'DELETE' });
    console.log(`[caddy] Removed route ${id}`);
  } catch (err) {
    if (err.status === 404) return; // already gone
    throw err;
  }
}

/**
 * List all current routes in the first server.
 */
export async function listRoutes() {
  try {
    const routes = await caddyRequest('/config/apps/http/servers/srv0/routes');
    return routes || [];
  } catch {
    return [];
  }
}

/**
 * Load a full Caddy JSON config.
 */
export async function loadConfig(config) {
  await caddyRequest('/load', {
    method: 'POST',
    body: config,
  });
  console.log('[caddy] Full config loaded');
}

/**
 * Check if Caddy admin API is reachable.
 */
export async function healthCheck() {
  try {
    await caddyRequest('/config/', { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}
