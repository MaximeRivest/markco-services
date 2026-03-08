/**
 * Share & collaboration routes for the orchestrator.
 *
 * Proxies share CRUD to auth-service and serves the join/collab web pages.
 */

import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { authService } from '../service-client.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DOMAIN = process.env.DOMAIN || 'markco.dev';
const IS_LOCAL_DOMAIN = /^(\d|localhost)/.test(DOMAIN);
const SYNC_RELAY_PORT = parseInt(process.env.SYNC_RELAY_PORT || '3006', 10);
const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

const ANALYTICS_SCRIPT_SRC = process.env.ANALYTICS_SCRIPT_SRC || '';
const ANALYTICS_WEBSITE_ID = process.env.ANALYTICS_WEBSITE_ID || '';

const tunnelClients = new Map();
let RuntimeTunnelClientClassPromise = null;

function relayWsUrl() {
  return `ws://127.0.0.1:${SYNC_RELAY_PORT}`;
}

async function loadRuntimeTunnelClientClass() {
  if (RuntimeTunnelClientClassPromise) return RuntimeTunnelClientClassPromise;

  RuntimeTunnelClientClassPromise = (async () => {
    const candidates = [
      path.resolve(__dirname, '../runtime-tunnel-client.js'),
      path.resolve(__dirname, '../../../../mrmd-server/src/runtime-tunnel-client.js'),
      '/opt/markco/markco-services/orchestrator/src/runtime-tunnel-client.js',
      '/opt/markco/editor-build/mrmd-server/src/runtime-tunnel-client.js',
      path.resolve(process.cwd(), '../../../mrmd-server/src/runtime-tunnel-client.js'),
    ];

    let lastErr = null;
    for (const candidate of candidates) {
      try {
        const mod = await import(pathToFileURL(candidate).href);
        if (mod?.RuntimeTunnelClient) return mod.RuntimeTunnelClient;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error('RuntimeTunnelClient not found');
  })();

  return RuntimeTunnelClientClassPromise;
}

function getAbsoluteUrl(req, pathname) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || appProtocol();
  const host = req.headers['x-forwarded-host'] || req.headers.host || DOMAIN;
  return `${protocol}://${host}${pathname}`;
}

function colorFromString(input = '') {
  let hash = 0;
  const str = String(input || 'guest');
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 55%)`;
}

function getMrmdBundlePath() {
  const candidates = [
    '/opt/markco/static/static/mrmd.iife.js',
    '/opt/markco/static/mrmd.iife.js',
    '/opt/markco/editor-build/mrmd-electron/editor/mrmd.iife.js',
    '/opt/markco/editor-build/mrmd-editor/dist/mrmd.iife.js',
    path.resolve(__dirname, '../../../../mrmd-editor/dist/mrmd.iife.js'),
    path.resolve(process.cwd(), '../mrmd-editor/dist/mrmd.iife.js'),
    path.resolve(process.cwd(), '../../mrmd-editor/dist/mrmd.iife.js'),
  ];
  return candidates.find(p => existsSync(p)) || candidates[candidates.length - 1];
}

export async function ensureTunnelClient(ownerId) {
  let client = tunnelClients.get(ownerId);
  if (client) return client;
  const RuntimeTunnelClient = await loadRuntimeTunnelClientClass();
  client = new RuntimeTunnelClient({
    relayUrl: relayWsUrl(),
    userId: ownerId,
  });
  client.start();
  tunnelClients.set(ownerId, client);
  return client;
}

function appProtocol() {
  return IS_LOCAL_DOMAIN ? 'http' : 'https';
}

function extractToken(req) {
  const queryToken = req.query?.token || (() => {
    try {
      const url = new URL(req.url || '', 'http://localhost');
      return url.searchParams.get('token') || null;
    } catch {
      return null;
    }
  })();

  const cookieToken = req.cookies?.session_token || (() => {
    const cookieHeader = req.headers?.cookie || '';
    const match = cookieHeader.match(/(?:^|;\s*)session_token=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  })();

  return queryToken
    || cookieToken
    || req.headers?.authorization?.replace('Bearer ', '');
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function analyticsTag() {
  if (!ANALYTICS_SCRIPT_SRC) return '';
  const w = ANALYTICS_WEBSITE_ID ? ` data-website-id="${ANALYTICS_WEBSITE_ID}"` : '';
  return `<script defer src="${ANALYTICS_SCRIPT_SRC}"${w}></script>`;
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    if (req.accepts('html') && !req.headers['x-requested-with']) {
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const { user } = await authService.validate(token);
    req.user = user;
    req.sessionToken = token;
    next();
  } catch (err) {
    if (err.status === 401) {
      if (req.accepts('html') && !req.headers['x-requested-with']) {
        return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
      }
      return res.status(401).json({ error: 'Invalid or expired session' });
    }
    return res.status(500).json({ error: 'Auth service unavailable' });
  }
}

/**
 * Check if a user's machine is online via the tunnel API.
 */
async function isOwnerOnline(ownerId) {
  try {
    const res = await fetch(
      `http://127.0.0.1:${SYNC_RELAY_PORT}/api/tunnel/${encodeURIComponent(ownerId)}`,
      {
        signal: AbortSignal.timeout(5000),
        headers: { 'X-User-Id': ownerId },
      }
    );
    if (!res.ok) return false;
    const data = await res.json();
    return data.available === true;
  } catch {
    return false;
  }
}

async function getCurrentUser(req) {
  const sessionToken = extractToken(req);
  if (!sessionToken) return null;
  try {
    const { user } = await authService.validate(sessionToken);
    return user || null;
  } catch {
    return null;
  }
}

export async function getShareAccessForToken(token, req = null, opts = {}) {
  const { joinIfNeeded = false } = opts;

  const share = await authService.getShareByToken(token);
  const currentUser = req ? await getCurrentUser(req) : null;
  const isOwner = currentUser?.id && currentUser.id === share.owner.id;

  if (!share.requireAuth || isOwner) {
    return { share, currentUser, isOwner };
  }

  if (!currentUser) {
    const err = new Error('Authentication required');
    err.status = 401;
    throw err;
  }

  if (joinIfNeeded && req) {
    await authService.joinShare(extractToken(req), token);
  }

  return { share, currentUser, isOwner };
}

async function requireCollabAccess(req, res, opts = {}) {
  try {
    return await getShareAccessForToken(req.params.token, req, opts);
  } catch (err) {
    res.status(err.status || 404).json(err.data || { error: err.message || 'Share not found' });
    return null;
  }
}

// ─── Share CRUD (proxy to auth-service) ──────────────────────────────

router.post('/api/shares', requireAuth, async (req, res) => {
  try {
    const data = await authService.createShare(req.sessionToken, req.body);
    res.status(201).json(data);
  } catch (err) {
    res.status(err.status || 500).json(err.data || { error: err.message });
  }
});

router.get('/api/shares', requireAuth, async (req, res) => {
  try {
    const data = await authService.listShares(req.sessionToken);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json(err.data || { error: err.message });
  }
});

router.get('/api/shares/shared-with-me', requireAuth, async (req, res) => {
  try {
    const data = await authService.listSharedWithMe(req.sessionToken);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json(err.data || { error: err.message });
  }
});

router.get('/api/shares/:id', requireAuth, async (req, res) => {
  try {
    const data = await authService.getShare(req.sessionToken, req.params.id);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json(err.data || { error: err.message });
  }
});

router.patch('/api/shares/:id', requireAuth, async (req, res) => {
  try {
    const data = await authService.updateShare(req.sessionToken, req.params.id, req.body);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json(err.data || { error: err.message });
  }
});

router.delete('/api/shares/:id', requireAuth, async (req, res) => {
  try {
    const data = await authService.deleteShare(req.sessionToken, req.params.id);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json(err.data || { error: err.message });
  }
});

// ─── Join flow ───────────────────────────────────────────────────────

router.post('/api/join/:token', requireAuth, async (req, res) => {
  try {
    const data = await authService.joinShare(req.sessionToken, req.params.token);
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json(err.data || { error: err.message });
  }
});

// Shared editor assets
router.get('/collab-assets/mrmd.iife.js', async (_req, res) => {
  try {
    res.type('application/javascript').send(await readFile(getMrmdBundlePath(), 'utf8'));
  } catch (err) {
    console.error('[collab-assets] Failed to load mrmd bundle:', err.message);
    res.status(500).send('// mrmd bundle unavailable');
  }
});

function getCollabApiBase(token) {
  return `/api/collab/${encodeURIComponent(token)}`;
}

async function sendCollabBootstrap(req, res) {
  const access = await requireCollabAccess(req, res, { joinIfNeeded: true });
  if (!access) return;

  const { share, currentUser, isOwner } = access;
  const ownerOnline = await isOwnerOnline(share.owner.id);
  const role = isOwner ? 'editor' : share.role;
  const readOnly = role === 'viewer' || !ownerOnline;
  const protocol = (req.headers['x-forwarded-proto'] || req.protocol || appProtocol()) === 'https' ? 'wss' : 'ws';
  const host = req.headers['x-forwarded-host'] || req.headers.host || DOMAIN;

  res.json({
    share: {
      token: req.params.token,
      project: share.project,
      docPath: share.docPath,
      role,
      requireAuth: share.requireAuth,
      owner: share.owner,
    },
    viewer: {
      id: currentUser?.id || null,
      name: currentUser?.name || currentUser?.email || 'Guest',
      color: colorFromString(currentUser?.id || currentUser?.email || req.ip || 'guest'),
      authenticated: !!currentUser,
    },
    syncUrl: `${protocol}://${host}${getCollabApiBase(req.params.token)}/sync`,
    ownerOnline,
    readOnly,
  });
}

async function sendCollabRuntimes(req, res, logPrefix = 'collab') {
  const access = await requireCollabAccess(req, res);
  if (!access) return;

  const { share, isOwner } = access;
  const ownerOnline = await isOwnerOnline(share.owner.id);
  if (!ownerOnline) {
    return res.status(409).json({ error: 'Owner is offline; runtimes unavailable' });
  }
  if (!isOwner && share.role === 'viewer') {
    return res.status(403).json({ error: 'Viewer share cannot start runtimes' });
  }

  try {
    const tunnelClient = await ensureTunnelClient(share.owner.id);
    const runtimes = await tunnelClient.startRuntime({
      sharedProject: share.project,
      sharedDocPath: share.docPath,
    });

    const runtimeUrls = {};
    for (const [language, info] of Object.entries(runtimes || {})) {
      if (info?.port) {
        runtimeUrls[language] = getAbsoluteUrl(req, `${getCollabApiBase(req.params.token)}/proxy/${info.port}/mrp/v1`);
      }
    }

    res.json({ ok: true, ownerOnline, runtimes, runtimeUrls });
  } catch (err) {
    console.error(`[${logPrefix}/runtimes] error:`, err.message);
    res.status(502).json({ error: err.message || 'Failed to start shared runtimes' });
  }
}

async function sendCollabProxy(req, res, { logPrefix = 'collab', routePrefix = '/api/collab' } = {}) {
  const access = await requireCollabAccess(req, res);
  if (!access) return;

  const { share, isOwner } = access;
  const ownerOnline = await isOwnerOnline(share.owner.id);
  if (!ownerOnline) {
    return res.status(409).json({ error: 'Owner is offline; proxy unavailable' });
  }
  if (!isOwner && share.role === 'viewer') {
    return res.status(403).json({ error: 'Viewer share is read-only' });
  }

  try {
    const tunnelClient = await ensureTunnelClient(share.owner.id);
    const reqUrl = req.originalUrl || req.url;
    const marker = `${routePrefix}/${encodeURIComponent(req.params.token)}/proxy/${req.params.port}`;
    const idx = reqUrl.indexOf(marker);
    const suffix = idx >= 0 ? reqUrl.slice(idx + marker.length) : req.url;
    req.url = suffix || '/';
    await tunnelClient.httpProxy(parseInt(req.params.port, 10), req, res);
  } catch (err) {
    console.error(`[${logPrefix}/proxy] error:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: err.message || 'Proxy unavailable' });
    }
  }
}

// Canonical collaboration API.
router.get('/api/collab/:token/bootstrap', sendCollabBootstrap);
router.post('/api/collab/:token/runtimes', (req, res) => sendCollabRuntimes(req, res, 'collab'));
router.all('/api/collab/:token/proxy/:port/*', (req, res) => sendCollabProxy(req, res, {
  logPrefix: 'collab',
  routePrefix: '/api/collab',
}));

// ─── GET /join/:token — Share landing page ───────────────────────────

function renderSharePage(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <meta name="color-scheme" content="dark light" />
  <link rel="icon" href="/favicon.ico" />
  ${analyticsTag()}
  <style>
    :root {
      --bg: #1a1b2e; --bg-subtle: #222336; --card: #2a2b3d;
      --card-elevated: #3d3552; --muted: #8a7a5e; --text: #d4c4a8;
      --text-bright: #ebe0cc; --accent: #c8a654; --accent-hover: #e8c874;
      --success: #8aab7c; --error: #c47862; --border: #3d3552;
      --shadow: 0 8px 32px rgba(0,0,0,.4);
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f2e8d5; --bg-subtle: #eaddc8; --card: #f2e8d5;
        --card-elevated: #e8dcc6; --muted: #6a6480; --text: #2a2540;
        --text-bright: #2a2540; --accent: #a07830; --accent-hover: #8a6a20;
        --success: #4a7a42; --error: #a04040; --border: #d4c4a8;
        --shadow: 0 2px 8px rgba(0,0,0,.08);
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh; display: grid; place-items: center; padding: 24px;
      font-family: Literata, Charter, Georgia, serif;
      background: var(--bg); color: var(--text); line-height: 1.6;
    }
    .card {
      width: min(520px, 100%); background: var(--card);
      border: 1px solid var(--border); border-radius: 8px;
      padding: 32px; box-shadow: var(--shadow);
    }
    h1 { font-size: 24px; color: var(--text-bright); font-weight: 600; margin-bottom: 8px; }
    h2 { font-size: 18px; color: var(--text-bright); font-weight: 600; margin: 16px 0 8px; }
    p { color: var(--muted); margin-bottom: 12px; }
    .owner { display: flex; align-items: center; gap: 12px; margin: 16px 0; }
    .owner img {
      width: 40px; height: 40px; border-radius: 50%;
      border: 2px solid var(--border);
    }
    .owner-name { font-weight: 600; color: var(--text-bright); }
    .owner-sub { font-size: 13px; color: var(--muted); }
    .doc-info {
      background: var(--bg-subtle); border: 1px solid var(--border);
      border-radius: 6px; padding: 12px 16px; margin: 16px 0;
      font-family: 'SF Mono', Monaco, Consolas, monospace; font-size: 14px;
      color: var(--text-bright);
    }
    .status {
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 13px; margin: 12px 0;
    }
    .dot {
      width: 8px; height: 8px; border-radius: 50%; display: inline-block;
    }
    .dot.online { background: var(--success); }
    .dot.offline { background: var(--error); }
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      border: 1px solid var(--border); background: var(--card-elevated);
      color: var(--text); border-radius: 6px; padding: 10px 20px;
      text-decoration: none; font-family: inherit; font-size: 14px;
      font-weight: 500; cursor: pointer; transition: .15s;
    }
    .btn:hover { background: rgba(200,166,84,.08); border-color: var(--muted); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .btn.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
    .actions { display: flex; gap: 10px; margin-top: 20px; flex-wrap: wrap; }
    .error-msg {
      border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
      background: color-mix(in srgb, var(--error) 8%, transparent);
      color: var(--error); border-radius: 6px; padding: 10px 14px;
      font-size: 14px; margin: 16px 0;
    }
    .offline-msg {
      border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
      background: color-mix(in srgb, var(--accent) 6%, transparent);
      color: var(--accent); border-radius: 6px; padding: 14px 16px;
      font-size: 14px; margin: 16px 0; line-height: 1.5;
    }
    code {
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      background: rgba(42,43,61,0.6); padding: 2px 6px;
      border-radius: 3px; font-size: 0.85em;
    }
    .meta { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

router.get('/join/:token', async (req, res) => {
  const shareToken = req.params.token;

  // 1. Look up the share
  let share;
  try {
    share = await authService.getShareByToken(shareToken);
  } catch (err) {
    const status = err.status || 500;
    let message = 'Something went wrong looking up this share link.';
    if (status === 404) message = 'This share link doesn\'t exist or has been deleted.';
    if (status === 410) message = err.data?.error || 'This share link has expired.';
    if (status === 403) message = err.data?.error || 'This share is currently paused.';

    return res.status(status).send(renderSharePage('markco.dev — Share not found', `
      <main class="card">
        <h1>Share unavailable</h1>
        <div class="error-msg">${escapeHtml(message)}</div>
        <div class="actions">
          <a class="btn" href="/">Go to markco.dev</a>
        </div>
      </main>
    `));
  }

  // 2. Check if owner is online
  const online = await isOwnerOnline(share.owner.id);

  // 3. Check if the current user is authenticated
  let currentUser = null;
  const sessionToken = extractToken(req);
  if (sessionToken) {
    try {
      const validated = await authService.validate(sessionToken);
      currentUser = validated.user;
    } catch { /* not logged in */ }
  }

  // 4. Build the page
  const ownerName = escapeHtml(share.owner.name || share.owner.username || 'Someone');
  const docLabel = share.docPath
    ? `${escapeHtml(share.project)} / ${escapeHtml(share.docPath)}`
    : escapeHtml(share.project);
  const roleLabel = share.role === 'viewer' ? 'view' : 'edit';

  const avatarHtml = share.owner.avatarUrl
    ? `<img src="${escapeHtml(share.owner.avatarUrl)}" alt="" />`
    : '';

  const statusHtml = online
    ? `<div class="status"><span class="dot online"></span> Online — collaboration available</div>`
    : `<div class="status"><span class="dot offline"></span> Offline</div>`;

  const offlineHtml = !online ? `
    <div class="offline-msg">
      <strong>${ownerName}'s computer is currently offline.</strong><br>
      Collaboration requires them to have MarkCo running.
      Open the link again once they come back online.
    </div>` : '';

  let actionsHtml;

  if (currentUser) {
    // Already logged in — show join button
    const isOwner = currentUser.id === share.owner.id;
    if (isOwner) {
      actionsHtml = `
        <p style="color: var(--success)">This is your own share.</p>
        <div class="actions">
          <a class="btn primary" href="/dashboard">Go to Dashboard</a>
        </div>`;
    } else {
      actionsHtml = `
        <p>Signed in as <strong>${escapeHtml(currentUser.name || currentUser.email)}</strong></p>
        <div class="actions">
          <button class="btn primary" id="join-btn">Join and collaborate</button>
          <a class="btn" href="/">Cancel</a>
        </div>
        <p id="join-status" style="margin-top:8px"></p>
        <script>
          document.getElementById('join-btn').addEventListener('click', async () => {
            const btn = document.getElementById('join-btn');
            const status = document.getElementById('join-status');
            btn.disabled = true;
            btn.textContent = 'Joining...';
            try {
              const res = await fetch('/api/join/${escapeHtml(shareToken)}', {
                method: 'POST',
                credentials: 'include',
              });
              const data = await res.json();
              if (!res.ok) throw new Error(data.error || 'Join failed');
              window.location.href = '/collab/${escapeHtml(shareToken)}';
            } catch (err) {
              status.textContent = err.message;
              status.style.color = 'var(--error)';
              btn.disabled = false;
              btn.textContent = 'Join and collaborate';
            }
          });
        </script>`;
    }
  } else if (share.requireAuth) {
    // Not logged in, auth required
    actionsHtml = `
      <div class="actions">
        <a class="btn primary" href="/login?next=${encodeURIComponent(`/join/${shareToken}`)}">Sign in to collaborate</a>
      </div>
      <p class="meta">Free account — no credit card required.</p>`;
  } else {
    // Open share — no auth required
    actionsHtml = `
      <div class="actions">
        <a class="btn primary" href="/collab/${escapeHtml(shareToken)}">Open notebook</a>
        <a class="btn" href="/login?next=${encodeURIComponent(`/join/${shareToken}`)}">Sign in first</a>
      </div>`;
  }

  const body = `
    <main class="card">
      <h1>Collaboration invite</h1>
      <div class="owner">
        ${avatarHtml}
        <div>
          <div class="owner-name">${ownerName}</div>
          <div class="owner-sub">invited you to ${roleLabel}</div>
        </div>
      </div>

      <div class="doc-info">${docLabel}</div>

      ${statusHtml}
      ${offlineHtml}
      ${actionsHtml}
    </main>`;

  res.send(renderSharePage(`markco.dev — ${ownerName} shared ${share.docPath || share.project}`, body));
});

// ─── GET /collab/:token — Direct collaboration editor ───────────────
router.get('/collab/:token', async (req, res) => {
  const shareToken = req.params.token;

  let share;
  try {
    share = await authService.getShareByToken(shareToken);
  } catch {
    return res.redirect(`/join/${shareToken}`);
  }

  const currentUser = await getCurrentUser(req);
  if (share.requireAuth && !currentUser) {
    return res.redirect(`/login?next=${encodeURIComponent(`/join/${shareToken}`)}`);
  }
  if (share.requireAuth && currentUser && currentUser.id !== share.owner.id) {
    try {
      await authService.joinShare(extractToken(req), shareToken);
    } catch {
      // bootstrap will enforce again
    }
  }

  const ownerName = escapeHtml(share.owner.name || share.owner.username || 'Someone');
  const docLabel = share.docPath
    ? `${escapeHtml(share.project)} / ${escapeHtml(share.docPath)}`
    : escapeHtml(share.project);

  res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>markco.dev — ${docLabel}</title>
  <meta name="color-scheme" content="dark light" />
  <link rel="icon" href="/favicon.ico" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Literata:ital,opsz,wght@0,7..72,200..900;1,7..72,200..900&display=swap" rel="stylesheet">
  ${analyticsTag()}
  <style>
    :root { --bg:#f4ead8; --panel:#fbf4e8; --border:#dccdb2; --text:#2a2540; --muted:#6a6480; --accent:#9a7428; --success:#4a7a42; --error:#a04040; }
    @media (prefers-color-scheme: dark) { :root { --bg:#171926; --panel:#202332; --border:#353b53; --text:#ebe0cc; --muted:#bba98a; --accent:#c8a654; --success:#8aab7c; --error:#c47862; } }
    * { box-sizing:border-box; margin:0; padding:0; }
    html, body { height:100%; background:var(--bg); color:var(--text); }
    body { font-family: Literata, Charter, Georgia, serif; }
    .app { display:grid; grid-template-rows:auto auto 1fr; height:100%; }
    .topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:10px 14px; background:var(--panel); border-bottom:1px solid var(--border); }
    .title h1 { margin:0; font-size:15px; font-weight:600; }
    .title p { margin:2px 0 0; font-size:12px; color:var(--muted); }
    .status { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); }
    .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
    .dot.online { background:var(--success); } .dot.offline { background:var(--error); }
    .banner { display:none; padding:10px 14px; border-bottom:1px solid var(--border); font-size:13px; }
    .banner.show { display:block; }
    .banner.info { background: color-mix(in srgb, var(--accent) 9%, transparent); color: var(--accent); }
    .banner.error { background: color-mix(in srgb, var(--error) 8%, transparent); color: var(--error); }
    #editor { min-height:0; height:100%; overflow:auto; }
    #editor .cm-editor { font-size:17px; height:100%; }
    #editor .cm-editor .cm-scroller { padding:20px 16px; overflow:auto; }
    #editor .cm-editor .cm-content { max-width:720px; margin:0 auto; font-family: Literata, Charter, Georgia, serif; }
    #editor .cm-editor .cm-gutters { display:none; }
    .loading { display:grid; place-items:center; height:100%; color:var(--muted); font-size:14px; }
    .actions a { color:var(--accent); text-decoration:none; }
  </style>
</head>
<body>
  <div class="app">
    <div class="topbar">
      <div class="title"><h1>${docLabel}</h1><p>Shared by ${ownerName}</p></div>
      <div class="status"><span class="dot" id="status-dot"></span><span id="status-text">Connecting…</span></div>
    </div>
    <div class="banner info" id="banner"></div>
    <div id="editor"><div class="loading" id="loading">Loading collaborative notebook…</div></div>
  </div>
  <script src="/collab-assets/mrmd.iife.js?v=20260308a"></script>
  <script>
    (() => {
      const shareToken = ${JSON.stringify(shareToken)};
      let editor = null;
      let drive = null;
      let runtimeUrls = {};
      const banner = document.getElementById('banner');
      const statusDot = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');
      const loading = document.getElementById('loading');
      const editorRoot = document.getElementById('editor');

      function setStatus({ ownerOnline, role, readOnly }) {
        statusDot.className = 'dot ' + (ownerOnline ? 'online' : 'offline');
        statusText.textContent = ownerOnline ? (readOnly ? 'Read-only' : 'Collaboration') : 'Owner offline';
        if (!ownerOnline) {
          banner.className = 'banner info show';
          banner.innerHTML = '<strong>${ownerName} is offline.</strong> Reload this page once their desktop app is back online.';
        } else if (role === 'viewer') {
          banner.className = 'banner info show';
          banner.innerHTML = 'This share is view-only.';
        } else {
          banner.className = 'banner';
          banner.textContent = '';
        }
      }

      async function fetchJson(url, options = {}) {
        const res = await fetch(url, { credentials: 'include', ...options });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        return data;
      }

      async function connectRuntimes() {
        const data = await fetchJson('/api/collab/' + encodeURIComponent(shareToken) + '/runtimes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        runtimeUrls = data.runtimeUrls || {};
        for (const [language, url] of Object.entries(runtimeUrls)) {
          try { editor.connectRuntime(language, url); } catch (err) { console.warn('[collab] runtime connect failed', language, err); }
        }
      }

      async function init() {
        try {
          const data = await fetchJson('/api/collab/' + encodeURIComponent(shareToken) + '/bootstrap');
          if (!data.share.docPath) throw new Error('Share a specific notebook for now.');
          setStatus(data);
          if (!data.ownerOnline) {
            if (loading) loading.textContent = 'Host is offline. Reload when they reconnect.';
            return;
          }

          drive = new window.mrmd.Drive(data.syncUrl, {
            maxCachedDocs: 1,
            syncTimeout: 60000,
            log: (entry) => { if (entry.level !== 'debug') console.log('[collab-drive]', entry); },
          });

          const handle = await drive.open(data.share.docPath);
          if (loading) loading.remove();

          editor = window.mrmd.create(editorRoot, {
            ydoc: handle.ydoc,
            awareness: handle.awareness,
            readonly: !!data.readOnly,
            userName: data.viewer.name || 'Guest',
            userColor: data.viewer.color || '#5b8def',
            dark: null,
            placeholder: 'This notebook is empty',
          });

          if (!data.readOnly) {
            try {
              await connectRuntimes();
              if (editor?.execution?.enableMonitorMode && runtimeUrls.python) {
                editor.execution.enableMonitorMode({ ydoc: handle.ydoc, awareness: handle.awareness, runtimeUrl: runtimeUrls.python });
              }
            } catch (err) {
              banner.className = 'banner info show';
              banner.textContent = 'Code execution not available yet: ' + (err.message || err);
            }
          }

          setInterval(async () => {
            try {
              const status = await fetchJson('/api/share-status/' + encodeURIComponent(shareToken));
              const shouldReadOnly = status.role === 'viewer' || !status.ownerOnline;
              if (editor?.setReadonly) editor.setReadonly(shouldReadOnly);
              setStatus(status);
              if (status.ownerOnline && !shouldReadOnly && !Object.keys(runtimeUrls).length) {
                try { await connectRuntimes(); } catch {}
              }
            } catch {}
          }, 10000);
        } catch (err) {
          console.error('[collab] bootstrap error:', err);
          banner.className = 'banner error show';
          banner.innerHTML = '<strong>Could not load this notebook.</strong> ' + (err.message || err) + ' <span class="actions"><a href="/join/${escapeHtml(shareToken)}">Back to share page</a></span>';
          if (loading) loading.textContent = 'Could not load editor.';
        }
      }

      init();
    })();
  </script>
</body>
</html>`);
});

// ─── GET /api/share-status/:token — Poll current collaboration status ──
router.get('/api/share-status/:token', async (req, res) => {
  const access = await requireCollabAccess(req, res);
  if (!access) return;

  const { share, isOwner } = access;
  const ownerOnline = await isOwnerOnline(share.owner.id);
  const role = isOwner ? 'editor' : share.role;
  res.json({
    ownerOnline,
    role,
    readOnly: role === 'viewer' || !ownerOnline,
    shareActive: share.active,
  });
});

export default router;
