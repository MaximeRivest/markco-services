/**
 * Main user-facing routes for the orchestrator.
 * Handles auth flow, dashboard, and user editor proxying.
 */

import { readFile, rm } from 'node:fs/promises';
import { Router } from 'express';
import { authService, computeManager } from '../service-client.js';
import { onUserLogin, onUserLogout, getEditorInfo, notifyRuntimePortChange } from '../user-lifecycle.js';

const router = Router();

const DOMAIN = process.env.DOMAIN || 'markco.dev';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const IS_LOCAL_DOMAIN = /^(\d|localhost)/.test(DOMAIN);

const SANDBOX_AI_UPSTREAM = (
  process.env.SANDBOX_AI_PROXY_TARGET
  || process.env.SANDBOX_AI_URL
  || process.env.MRMD_AI_URL
  || 'http://127.0.0.1:51790'
).replace(/\/$/, '');

const SYNC_RELAY_PORT = parseInt(process.env.SYNC_RELAY_PORT || '3006', 10);

const SANDBOX_AI_FORWARD_HEADERS = new Set([
  'content-type',
  'accept',
  'x-juice-level',
  'x-reasoning-level',
  'x-model-override',
  'x-api-key-anthropic',
  'x-api-key-openai',
  'x-api-key-groq',
  'x-api-key-gemini',
  'x-api-key-openrouter',
  'x-api-key-together_ai',
  'x-api-key-fireworks_ai',
  'x-api-key-azure',
  'x-api-key-bedrock',
  'x-api-key-vertex_ai',
  'x-api-key-cohere',
  'x-api-key-mistral',
  'x-api-key-deepseek',
  'x-api-key-ollama',
]);

const PWA_ICON_CANDIDATES = {
  128: [
    process.env.PWA_ICON_128_PATH,
    '/opt/markco/editor-build/mrmd-electron/assets/icon-128.png',
    '/opt/markco/static/static/assets/icon-128.png',
    `${process.cwd()}/mrmd-electron/assets/icon-128.png`,
  ].filter(Boolean),
  256: [
    process.env.PWA_ICON_256_PATH,
    '/opt/markco/editor-build/mrmd-electron/assets/icon-256.png',
    '/opt/markco/static/static/assets/icon-256.png',
    `${process.cwd()}/mrmd-electron/assets/icon-256.png`,
  ].filter(Boolean),
  512: [
    process.env.PWA_ICON_512_PATH,
    '/opt/markco/editor-build/mrmd-electron/assets/icon-512.png',
    '/opt/markco/static/static/assets/icon-512.png',
    `${process.cwd()}/mrmd-electron/assets/icon-512.png`,
  ].filter(Boolean),
};

const FAVICON_CANDIDATES = [
  process.env.FAVICON_PATH,
  '/opt/markco/editor-build/mrmd-server/static/favicon.png',
  '/opt/markco/static/static/favicon.png',
  `${process.cwd()}/mrmd-server/static/favicon.png`,
  `${process.cwd()}/mrmd-electron/assets/icon-128.png`,
].filter(Boolean);

const ANALYTICS_SCRIPT_SRC = process.env.ANALYTICS_SCRIPT_SRC || '';
const ANALYTICS_WEBSITE_ID = process.env.ANALYTICS_WEBSITE_ID || '';

const ANDROID_APP_PACKAGE = (process.env.ANDROID_APP_PACKAGE || '').trim();
const ANDROID_APP_SHA256_CERT_FINGERPRINTS = (process.env.ANDROID_APP_SHA256_CERT_FINGERPRINTS
  || process.env.ANDROID_APP_SHA256_CERT_FINGERPRINT
  || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const ANDROID_ASSETLINKS_JSON = process.env.ANDROID_ASSETLINKS_JSON || '';

function extractToken(req) {
  return req.query.token
    || req.cookies?.session_token
    || req.headers.authorization?.replace('Bearer ', '');
}

function sessionCookieOptions(extra = {}) {
  const base = {
    httpOnly: true,
    secure: !IS_LOCAL_DOMAIN,
    sameSite: 'lax',
    path: '/',
  };

  if (!IS_LOCAL_DOMAIN) {
    base.domain = DOMAIN;
  }

  return { ...base, ...extra };
}

function clearSessionCookie(res) {
  // Current cookie shape
  res.clearCookie('session_token', sessionCookieOptions());

  // Legacy cookie shape used earlier (leading dot)
  if (!IS_LOCAL_DOMAIN) {
    res.clearCookie('session_token', {
      ...sessionCookieOptions(),
      domain: `.${DOMAIN}`,
    });
  }
}

function appProtocol() {
  return IS_LOCAL_DOMAIN ? 'http' : 'https';
}

function htmlMode(req) {
  return req.accepts('html') && !req.headers['x-requested-with'];
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pwaHeadTags() {
  return `
  <meta name="theme-color" content="#1e1e1e" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/favicon.ico" />
  <link rel="apple-touch-icon" href="/pwa/icon-256.png" />
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch((err) => {
          console.warn('[pwa] Service worker registration failed', err);
        });
      });
    }
  </script>`;
}

function pwaServiceWorkerSource() {
  return `const CACHE_NAME = 'markco-pwa-v1';
const PRECACHE = ['/offline', '/manifest.webmanifest', '/pwa/icon-128.png', '/pwa/icon-256.png', '/pwa/icon-512.png', '/favicon.ico'];
const BYPASS_PREFIXES = ['/api/', '/auth/', '/hooks/', '/join/', '/projects/', '/u/'];
const BYPASS_PATHS = new Set(['/login', '/dashboard', '/logout', '/api/logout']);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

function shouldBypass(pathname) {
  if (BYPASS_PATHS.has(pathname)) return true;
  return BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (shouldBypass(url.pathname)) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        return (await caches.match('/offline')) || new Response('Offline', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/static/') || url.pathname.startsWith('/pwa/') || url.pathname === '/favicon.ico') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);

      const networkPromise = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) cache.put(req, resp.clone());
          return resp;
        })
        .catch(() => null);

      if (cached) {
        networkPromise.catch(() => {});
        return cached;
      }

      return (await networkPromise) || new Response('', { status: 504 });
    })());
  }
});`;
}

function analyticsScriptTag() {
  if (!ANALYTICS_SCRIPT_SRC) return '';

  const websiteAttr = ANALYTICS_WEBSITE_ID
    ? ` data-website-id="${ANALYTICS_WEBSITE_ID}"`
    : '';

  return `<script defer src="${ANALYTICS_SCRIPT_SRC}"${websiteAttr}></script>`;
}

function injectPwaAndAnalyticsIntoHtml(html) {
  if (!html || !html.includes('</head>')) return html;

  const chunks = [];

  if (!html.includes('href="/manifest.webmanifest"')) {
    chunks.push(pwaHeadTags());
  }

  const analytics = analyticsScriptTag();
  if (analytics && !html.includes(`src="${ANALYTICS_SCRIPT_SRC}"`)) {
    chunks.push(analytics);
  }

  if (chunks.length === 0) return html;

  return html.replace('</head>', `  ${chunks.join('\n  ')}\n</head>`);
}

function buildAssetLinksPayload() {
  if (ANDROID_ASSETLINKS_JSON) {
    try {
      const parsed = JSON.parse(ANDROID_ASSETLINKS_JSON);
      if (Array.isArray(parsed)) return parsed;
      console.warn('[assetlinks] ANDROID_ASSETLINKS_JSON must be a JSON array');
    } catch (err) {
      console.warn('[assetlinks] Failed to parse ANDROID_ASSETLINKS_JSON:', err.message);
    }
  }

  if (!ANDROID_APP_PACKAGE || ANDROID_APP_SHA256_CERT_FINGERPRINTS.length === 0) {
    return [];
  }

  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app',
      package_name: ANDROID_APP_PACKAGE,
      sha256_cert_fingerprints: ANDROID_APP_SHA256_CERT_FINGERPRINTS,
    },
  }];
}

async function sendPwaIcon(res, size) {
  const candidates = PWA_ICON_CANDIDATES[size] || [];

  for (const iconPath of candidates) {
    try {
      const data = await readFile(iconPath);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.type('png').send(data);
    } catch {
      // try next
    }
  }

  return res.status(404).send(`PWA icon ${size} not found`);
}

async function sendFavicon(res) {
  for (const iconPath of FAVICON_CANDIDATES) {
    try {
      const data = await readFile(iconPath);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.type('png').send(data);
    } catch {
      // try next
    }
  }

  return sendPwaIcon(res, 128);
}

function buildSandboxAiHeaders(req) {
  const headers = {
    'Content-Type': req.headers['content-type'] || 'application/json',
    Accept: req.headers.accept || '*/*',
  };

  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (SANDBOX_AI_FORWARD_HEADERS.has(lower) && value != null) {
      headers[key] = value;
    }
  }

  return headers;
}

async function proxySandboxAi(req, res, upstreamPath) {
  const targetUrl = `${SANDBOX_AI_UPSTREAM}${upstreamPath}`;

  try {
    const response = await fetch(targetUrl, {
      method: req.method,
      headers: buildSandboxAiHeaders(req),
      body: ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(180000),
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!['content-length', 'transfer-encoding', 'content-encoding', 'connection'].includes(lower)) {
        res.setHeader(key, value);
      }
    });

    if (!response.body) {
      return res.end();
    }

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    return res.end();
  } catch (err) {
    console.error(`[sandbox-ai] Proxy error for ${targetUrl}:`, err.message);
    return res.status(502).json({
      error: 'AI proxy unavailable',
      detail: err.message,
    });
  }
}

async function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    if (htmlMode(req)) return res.redirect('/login');
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const { user } = await authService.validate(token);
    req.user = user;
    req.sessionToken = token;

    // Refresh cookie if auth came via query/header
    if (req.query.token || req.headers.authorization) {
      res.cookie('session_token', token, sessionCookieOptions({
        maxAge: 30 * 24 * 60 * 60 * 1000,
      }));
    }

    // Clean token from URL once cookie is set (avoids weird/shareable token URLs)
    if (req.query.token && htmlMode(req)) {
      const clean = new URL(req.originalUrl, `${appProtocol()}://${DOMAIN}`);
      clean.searchParams.delete('token');
      const nextUrl = `${clean.pathname}${clean.search}` || '/';
      return res.redirect(nextUrl);
    }

    next();
  } catch (err) {
    if (err.status === 401) {
      if (htmlMode(req)) return res.redirect('/login');
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    console.error('[auth] Validation error:', err.message);
    return res.status(500).json({ error: 'Auth service unavailable' });
  }
}

function renderPage(title, body, { landing = false } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <meta name="color-scheme" content="dark light" />
  ${pwaHeadTags()}
  ${analyticsScriptTag()}
  <style>
    /* ── Dark (default / midnight) ─────────────────────────── */
    :root {
      --bg: #1e1e1e;
      --bg-subtle: #252526;
      --card: #252526;
      --card-elevated: #2d2d2d;
      --muted: #888888;
      --text: #cccccc;
      --text-bright: #e0e0e0;
      --accent: #6495ed;
      --accent-hover: #7ba6f7;
      --accent-muted: rgba(100, 149, 237, 0.12);
      --success: #4caf50;
      --error: #f44336;
      --border: #3c3c3c;
      --border-subtle: rgba(255, 255, 255, 0.08);
      --shadow: 0 8px 32px rgba(0,0,0,.4);
      --code-bg: rgba(255, 255, 255, 0.06);
      --hover-bg: rgba(255, 255, 255, 0.05);
      --syntax-keyword: #569cd6;
      --syntax-string: #ce9178;
      --syntax-comment: #6a9955;
      --syntax-function: #dcdcaa;
      --syntax-number: #b5cea8;
      --syntax-property: #9cdcfe;
      --syntax-punctuation: #808080;
    }

    /* ── Light (daylight) ──────────────────────────────────── */
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #ffffff;
        --bg-subtle: #fafafa;
        --card: #ffffff;
        --card-elevated: #fafafa;
        --muted: #78909c;
        --text: #37474f;
        --text-bright: #000000;
        --accent: #1976d2;
        --accent-hover: #1565c0;
        --accent-muted: rgba(25, 118, 210, 0.08);
        --success: #388e3c;
        --error: #d32f2f;
        --border: #e0e0e0;
        --border-subtle: rgba(0, 0, 0, 0.06);
        --shadow: 0 2px 8px rgba(0,0,0,.08);
        --code-bg: #f5f5f5;
        --hover-bg: rgba(0, 0, 0, 0.03);
        --syntax-keyword: #0d47a1;
        --syntax-string: #2e7d32;
        --syntax-comment: #757575;
        --syntax-function: #6a1b9a;
        --syntax-number: #e65100;
        --syntax-property: #0d47a1;
        --syntax-punctuation: #90a4ae;
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      min-height: 100vh;
      font-family: Literata, Charter, Georgia, serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Shared components ──────────────────────────────────── */

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      border: 1px solid var(--border);
      background: var(--card-elevated);
      color: var(--text);
      border-radius: 6px;
      padding: 10px 16px;
      text-decoration: none;
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background .15s ease, border-color .15s ease;
    }
    .btn:hover { background: var(--hover-bg); border-color: var(--muted); }
    .btn.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    .btn.primary:hover {
      background: var(--accent-hover);
      border-color: var(--accent-hover);
    }
    .btn.ghost {
      background: transparent;
      border-color: var(--border);
    }
    .btn.ghost:hover {
      background: var(--hover-bg);
    }
    .btn.disabled {
      opacity: .45;
      pointer-events: none;
      cursor: not-allowed;
    }

    code {
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 0.85em;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      border: 1px solid;
      border-color: color-mix(in srgb, var(--success) 40%, transparent);
      background: color-mix(in srgb, var(--success) 8%, transparent);
      color: var(--success);
      font-size: 11px;
      border-radius: 999px;
      padding: 3px 8px;
      margin-left: 8px;
    }

    .flash {
      border: 1px solid color-mix(in srgb, var(--success) 40%, transparent);
      background: color-mix(in srgb, var(--success) 8%, transparent);
      color: var(--success);
      border-radius: 6px;
      padding: 10px 14px;
      font-size: 14px;
    }

    .flash.error {
      border-color: color-mix(in srgb, var(--error) 40%, transparent);
      background: color-mix(in srgb, var(--error) 8%, transparent);
      color: var(--error);
    }

    /* ── Card pages (login, dashboard) ──────────────────────── */

    .page-card {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .page-card .card {
      width: min(560px, 100%);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 32px;
      box-shadow: var(--shadow);
    }
    .page-card h1 {
      font-size: 28px;
      line-height: 1.2;
      color: var(--text-bright);
      font-weight: 600;
      margin-bottom: 8px;
    }
    .page-card p { color: var(--muted); }
    .page-card .stack { display: grid; gap: 10px; margin-top: 24px; }
    .page-card .row { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
    .page-card .divider { display: flex; align-items: center; gap: 12px; margin: 20px 0 4px; color: var(--muted); font-size: 13px; }
    .page-card .divider::before, .page-card .divider::after { content: ''; flex: 1; border-top: 1px solid var(--border); }
    .page-card .email-form { display: grid; gap: 10px; margin-top: 12px; }
    .page-card .input {
      padding: 10px 14px;
      font-size: 15px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text-bright);
      outline: none;
    }
    .page-card .input:focus { border-color: var(--muted); }
    .page-card .meta {
      margin-top: 20px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
      font-size: 13px;
      color: var(--muted);
    }

    ${landing ? `
    /* ── Landing page ────────────────────────────────────────── */

    .landing-nav {
      position: sticky;
      top: 0;
      z-index: 10;
      background: color-mix(in srgb, var(--bg) 85%, transparent);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-subtle);
      padding: 0 24px;
    }
    .landing-nav-inner {
      max-width: 960px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 56px;
    }
    .landing-logo {
      font-weight: 700;
      font-size: 17px;
      color: var(--text-bright);
      text-decoration: none;
    }
    .landing-nav-links {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    .landing-nav-links a {
      color: var(--muted);
      text-decoration: none;
      font-size: 14px;
      padding: 6px 12px;
      border-radius: 6px;
      transition: color .15s;
    }
    .landing-nav-links a:hover { color: var(--text-bright); }

    .landing-hero {
      max-width: 960px;
      margin: 0 auto;
      padding: 80px 24px 60px;
      text-align: center;
    }
    .landing-hero h1 {
      font-size: clamp(32px, 5vw, 48px);
      font-weight: 700;
      line-height: 1.15;
      color: var(--text-bright);
      margin-bottom: 20px;
      letter-spacing: -0.02em;
    }
    .landing-hero .subtitle {
      font-size: clamp(16px, 2.5vw, 19px);
      color: var(--muted);
      max-width: 600px;
      margin: 0 auto 36px;
      line-height: 1.6;
    }
    .landing-hero .cta-row {
      display: flex;
      gap: 12px;
      justify-content: center;
      flex-wrap: wrap;
    }
    .landing-hero .btn { padding: 12px 24px; font-size: 15px; }

    .landing-section {
      max-width: 960px;
      margin: 0 auto;
      padding: 60px 24px;
    }
    .landing-section + .landing-section {
      border-top: 1px solid var(--border-subtle);
    }
    .landing-section h2 {
      font-size: 24px;
      font-weight: 600;
      color: var(--text-bright);
      margin-bottom: 12px;
    }
    .landing-section p {
      color: var(--muted);
      max-width: 640px;
      margin-bottom: 28px;
    }

    .feature-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 20px;
    }
    .feature-item {
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 24px;
    }
    .feature-item h3 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-bright);
      margin-bottom: 8px;
    }
    .feature-item p {
      font-size: 14px;
      color: var(--muted);
      margin: 0;
      line-height: 1.55;
    }

    .code-preview {
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 20px 24px;
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      font-size: 13px;
      line-height: 1.65;
      overflow-x: auto;
      max-width: 640px;
    }
    .code-preview .kw { color: var(--syntax-keyword); }
    .code-preview .str { color: var(--syntax-string); }
    .code-preview .cm { color: var(--syntax-comment); font-style: italic; }
    .code-preview .fn { color: var(--syntax-function); }
    .code-preview .num { color: var(--syntax-number); }
    .code-preview .prop { color: var(--syntax-property); }
    .code-preview .punc { color: var(--syntax-punctuation); }
    .code-preview .out {
      display: block;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border-subtle);
      color: var(--muted);
    }

    .lang-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
    }
    .lang-tag {
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 4px;
      background: var(--accent-muted);
      color: var(--accent);
      border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
    }

    .landing-footer {
      border-top: 1px solid var(--border-subtle);
      padding: 32px 24px;
      text-align: center;
      font-size: 13px;
      color: var(--muted);
    }
    .landing-footer a {
      color: var(--accent);
      text-decoration: none;
    }
    .landing-footer a:hover { text-decoration: underline; }
    ` : ''}
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

function githubOAuthUrl() {
  const redirectUri = `${appProtocol()}://${DOMAIN}/auth/callback/github`;
  const scope = 'read:user user:email';
  return `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(GITHUB_CLIENT_ID)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
}

function googleOAuthUrl() {
  const redirectUri = `${appProtocol()}://${DOMAIN}/auth/callback/google`;
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    prompt: 'select_account',
    access_type: 'online',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function completeLogin(res, user, token, expiresAt) {
  res.cookie('session_token', token, sessionCookieOptions({
    expires: new Date(expiresAt),
  }));

  // Check if this is an Electron auth flow
  const isElectron = res.req?.cookies?.electron_auth === '1';
  if (isElectron) {
    res.clearCookie('electron_auth');
    // Don't start editor containers for Electron auth — just return the token
    return res.redirect(`/auth/electron/success?token=${encodeURIComponent(token)}`);
  }

  try {
    await onUserLogin(user);
  } catch (err) {
    console.error(`[callback] Failed to start editor for ${user.id}: ${err.message}`);
  }

  res.redirect('/dashboard');
}

// ── PWA assets/routes ─────────────────────────────────────────────────
router.get('/manifest.webmanifest', (_req, res) => {
  const manifest = {
    id: '/',
    name: 'MarkCo',
    short_name: 'MarkCo',
    description: 'Markdown notebooks with code, collaboration, and publishing.',
    start_url: '/?source=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    theme_color: '#1e1e1e',
    background_color: '#1e1e1e',
    icons: [
      { src: '/pwa/icon-128.png', sizes: '128x128', type: 'image/png' },
      { src: '/pwa/icon-256.png', sizes: '256x256', type: 'image/png' },
      { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
    shortcuts: [
      { name: 'Open Sandbox', short_name: 'Sandbox', url: '/sandbox', icons: [{ src: '/pwa/icon-128.png', sizes: '128x128' }] },
      { name: 'Login', short_name: 'Login', url: '/login', icons: [{ src: '/pwa/icon-128.png', sizes: '128x128' }] },
    ],
  };

  if (ANDROID_APP_PACKAGE) {
    manifest.related_applications = [{
      platform: 'play',
      id: ANDROID_APP_PACKAGE,
    }];
    manifest.prefer_related_applications = false;
  }

  res.setHeader('Cache-Control', 'no-cache');
  return res.type('application/manifest+json').send(JSON.stringify(manifest, null, 2));
});

router.get('/.well-known/assetlinks.json', (_req, res) => {
  const payload = buildAssetLinksPayload();
  res.setHeader('Cache-Control', 'no-cache');
  return res.type('application/json').send(JSON.stringify(payload, null, 2));
});

router.get('/assetlinks.json', (_req, res) => {
  const payload = buildAssetLinksPayload();
  res.setHeader('Cache-Control', 'no-cache');
  return res.type('application/json').send(JSON.stringify(payload, null, 2));
});

router.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  return res.type('application/javascript').send(pwaServiceWorkerSource());
});

router.get('/offline', (_req, res) => {
  const body = `<div class="page-card"><main class="card">
    <h1>You're offline</h1>
    <p>markco.dev needs a network connection for sign-in and cloud execution.</p>
    <p>You can still reopen this page when your connection is back.</p>
    <div class="row" style="margin-top:20px">
      <a class="btn primary" href="/sandbox">Open Sandbox</a>
      <a class="btn ghost" href="/">Back to home</a>
    </div>
  </main></div>`;

  res.setHeader('Cache-Control', 'no-store');
  return res.send(renderPage('markco.dev — Offline', body));
});

router.get('/favicon.ico', async (_req, res) => sendFavicon(res));
router.get('/pwa/icon-128.png', async (_req, res) => sendPwaIcon(res, 128));
router.get('/pwa/icon-256.png', async (_req, res) => sendPwaIcon(res, 256));
router.get('/pwa/icon-512.png', async (_req, res) => sendPwaIcon(res, 512));

// ── GET / ─────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  // If already logged in, go straight to dashboard
  const token = extractToken(req);
  if (token) {
    try {
      await authService.validate(token);
      return res.redirect('/dashboard');
    } catch { /* show landing */ }
  }

  const body = `
<nav class="landing-nav">
  <div class="landing-nav-inner">
    <a href="/" class="landing-logo">markco.dev</a>
    <div class="landing-nav-links">
      <a href="/sandbox">Try it</a>
      <a href="https://github.com/MaximeRivest/markco-services">Source</a>
      <a href="/login" class="btn primary" style="padding:6px 16px;font-size:13px">Sign in</a>
    </div>
  </div>
</nav>

<section class="landing-hero">
  <h1>Markdown notebooks with code, collaboration, and publishing</h1>
  <p class="subtitle">
    Write prose, run code, see results inline. Python, R, Julia, JavaScript, and Bash
    in a single document. Real-time collaboration. Publish to the web with one action.
    Your files stay as plain <code>.md</code> files.
  </p>
  <div class="cta-row">
    <a class="btn primary" href="/login">Get started</a>
    <a class="btn ghost" href="/sandbox">Try in browser</a>
  </div>
</section>

<section class="landing-section">
  <h2>A document, not an app</h2>
  <p>
    Write markdown. Fence a code block. Run it. The output appears right below, in the same
    document. Variables persist across cells. Everything is saved as a plain text file you can
    version control, grep, and open in any editor.
  </p>
  <div class="code-preview">
    <span class="cm"># Analysis</span><br><br>
    <span class="punc">\`\`\`</span><span class="prop">python</span><br>
    <span class="kw">import</span> pandas <span class="kw">as</span> pd<br>
    df <span class="punc">=</span> pd<span class="punc">.</span><span class="fn">read_csv</span><span class="punc">(</span><span class="str">'data.csv'</span><span class="punc">)</span><br>
    df<span class="punc">.</span><span class="fn">describe</span><span class="punc">()</span><br>
    <span class="punc">\`\`\`</span>
    <span class="out">       value    count<br>mean   42.3     1024<br>std    12.1      256</span>
  </div>
</section>

<section class="landing-section">
  <h2>Multi-language, one notebook</h2>
  <p>
    Each code block declares its language. Run Python for data, R for statistics, Julia for
    simulation, Bash for system tasks, JavaScript for visualization -- all in the same file,
    with outputs inline.
  </p>
  <div class="lang-list">
    <span class="lang-tag">python</span>
    <span class="lang-tag">r</span>
    <span class="lang-tag">julia</span>
    <span class="lang-tag">javascript</span>
    <span class="lang-tag">bash</span>
    <span class="lang-tag">html</span>
    <span class="lang-tag">sql</span>
    <span class="lang-tag">mermaid</span>
  </div>
</section>

<section class="landing-section">
  <h2>Built for depth</h2>
  <div class="feature-grid">
    <div class="feature-item">
      <h3>Real-time collaboration</h3>
      <p>CRDT-based editing. Multiple people work on the same document simultaneously.
         Cursor presence, no conflicts, works offline and merges on reconnect.</p>
    </div>
    <div class="feature-item">
      <h3>Runtime intelligence</h3>
      <p>Hover a variable to see its value, not just its type. Autocomplete from the
         live runtime session. Inspect dataframes, preview plots, explore state.</p>
    </div>
    <div class="feature-item">
      <h3>Publish to the web</h3>
      <p>One action turns a notebook into a published page. Share analysis, documentation,
         or interactive articles as a URL. No export step.</p>
    </div>
    <div class="feature-item">
      <h3>Themeable</h3>
      <p>A unified design token system controls everything from syntax highlighting to
         widgets to the shell. Ship your own theme or use the built-in dark and light modes.</p>
    </div>
    <div class="feature-item">
      <h3>AI-native, not AI-dependent</h3>
      <p>AI writes to the document the same way you do -- as a collaborator. It supports
         thinking and exploration without replacing the work.</p>
    </div>
    <div class="feature-item">
      <h3>Plain markdown files</h3>
      <p>No proprietary format. No JSON cell arrays. Your documents are <code>.md</code> files.
         Version control, diff, grep, and open them anywhere.</p>
    </div>
  </div>
</section>

<section class="landing-section">
  <h2>Open source</h2>
  <p>
    The editor, runtimes, sync layer, and platform services are all open source. Build on top
    of them, self-host, or use the hosted version at markco.dev.
  </p>
  <div class="cta-row" style="justify-content:flex-start">
    <a class="btn primary" href="/login">Get started</a>
    <a class="btn ghost" href="/sandbox">Try without an account</a>
    <a class="btn ghost" href="https://github.com/MaximeRivest/markco-services">View source</a>
  </div>
</section>

<footer class="landing-footer">
  markco.dev -- built slowly, with care.
</footer>`;

  return res.send(renderPage('markco.dev — Markdown notebooks with code, collaboration, and publishing', body, { landing: true }));
});

// ── GET /privacy ─────────────────────────────────────────────────────
router.get('/privacy', (_req, res) => {
  const body = `<div class="page-card"><main class="card">
    <h1>Privacy Policy</h1>
    <p>Last updated: 2026-02-15</p>
    <p>MarkCo provides markdown notebooks with code execution and publishing. This page applies to markco.dev and the Android app wrapper.</p>

    <h2 style="margin-top:18px">What we collect</h2>
    <p>When you sign in, we collect account identifiers (for example GitHub/Google ID, name, email, avatar), session tokens, and basic operational logs needed to run the service.</p>

    <h2 style="margin-top:18px">Notebook content</h2>
    <p>Your notebooks and execution outputs are stored to provide the product features (editing, running, syncing, and publishing when requested by you).</p>

    <h2 style="margin-top:18px">Analytics</h2>
    <p>We may use privacy-focused aggregate analytics to understand usage and improve reliability. We do not sell personal data.</p>

    <h2 style="margin-top:18px">Contact</h2>
    <p>Questions: <a href="mailto:hello@markco.dev">hello@markco.dev</a></p>

    <h2 style="margin-top:18px">Account deletion</h2>
    <p>Request or perform account deletion at <a href="/account-delete">markco.dev/account-delete</a>.</p>

    <div class="row" style="margin-top:20px">
      <a class="btn ghost" href="/account-delete">Delete account</a>
      <a class="btn ghost" href="/">Back to home</a>
    </div>
  </main></div>`;

  return res.send(renderPage('markco.dev — Privacy Policy', body));
});

// ── GET /terms ───────────────────────────────────────────────────────
router.get('/terms', (_req, res) => {
  const body = `<div class="page-card"><main class="card">
    <h1>Terms of Service</h1>
    <p>Last updated: 2026-02-15</p>
    <p>By using MarkCo, you agree to use the service lawfully and responsibly.</p>

    <h2 style="margin-top:18px">Acceptable use</h2>
    <p>Do not use the service to violate laws, abuse infrastructure, or access data you do not own.</p>

    <h2 style="margin-top:18px">Availability</h2>
    <p>The service is provided as-is and may change over time. We may suspend access to protect platform security and reliability.</p>

    <h2 style="margin-top:18px">Contact</h2>
    <p>Questions: <a href="mailto:hello@markco.dev">hello@markco.dev</a></p>

    <div class="row" style="margin-top:20px">
      <a class="btn ghost" href="/">Back to home</a>
    </div>
  </main></div>`;

  return res.send(renderPage('markco.dev — Terms of Service', body));
});

// ── GET /account-delete ──────────────────────────────────────────────
router.get('/account-delete', async (req, res) => {
  let user = null;
  const token = extractToken(req);

  if (token) {
    try {
      const validated = await authService.validate(token);
      user = validated.user || null;
    } catch {
      // show public instructions only
    }
  }

  const signedInSection = user ? `
    <h2 style="margin-top:18px">Delete now</h2>
    <p>Signed in as <code>${escapeHtml(user.email || user.username || user.id)}</code>.</p>
    <p>This will permanently delete your MarkCo account, active sessions, and workspace data.</p>
    <button id="delete-account-btn" class="btn primary" type="button">Delete account permanently</button>
    <p id="delete-account-status" class="meta" style="margin-top:10px"></p>
    <script>
      (() => {
        const btn = document.getElementById('delete-account-btn');
        const status = document.getElementById('delete-account-status');
        if (!btn) return;

        btn.addEventListener('click', async () => {
          const confirmed = confirm('Delete your MarkCo account and associated data permanently? This cannot be undone.');
          if (!confirmed) return;

          btn.disabled = true;
          btn.textContent = 'Deleting...';
          status.textContent = 'Deleting account...';

          try {
            const res = await fetch('/api/account/delete', { method: 'POST', credentials: 'include' });
            if (!res.ok) {
              let detail = 'Request failed';
              try {
                const json = await res.json();
                detail = json.error || detail;
              } catch {}
              throw new Error(detail);
            }

            status.textContent = 'Account deleted. Redirecting...';
            setTimeout(() => {
              window.location.href = '/?account_deleted=1';
            }, 500);
          } catch (err) {
            status.textContent = 'Could not delete account: ' + (err?.message || err);
            btn.disabled = false;
            btn.textContent = 'Delete account permanently';
          }
        });
      })();
    </script>
  ` : `
    <h2 style="margin-top:18px">Delete by request</h2>
    <p>Sign in first to self-delete instantly, or send a deletion request to
       <a href="mailto:hello@markco.dev?subject=MarkCo%20account%20deletion%20request">hello@markco.dev</a>
       from the email address associated with your account.</p>
    <div class="row" style="margin-top:12px">
      <a class="btn primary" href="/login">Sign in to delete now</a>
    </div>
  `;

  const body = `<div class="page-card"><main class="card">
    <h1>Delete your MarkCo account</h1>
    <p>Use this page to request deletion of your MarkCo account and associated notebook data.</p>

    ${signedInSection}

    <h2 style="margin-top:18px">What gets deleted</h2>
    <p>Your user profile, active sessions, and workspace files stored by MarkCo.</p>

    <h2 style="margin-top:18px">Retention</h2>
    <p>Operational backups may persist for up to 30 days before permanent removal.</p>

    <div class="row" style="margin-top:20px">
      <a class="btn ghost" href="/privacy">Privacy policy</a>
      <a class="btn ghost" href="/">Back to home</a>
    </div>
  </main></div>`;

  return res.send(renderPage('markco.dev — Delete account', body));
});

// ── GET /login ────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  const existingToken = extractToken(req);
  if (existingToken) {
    try {
      await authService.validate(existingToken);
      return res.redirect('/dashboard');
    } catch {
      // invalid token → show login
    }
  }

  const loggedOut = req.query.logged_out === '1';
  const error = req.query.error ? escapeHtml(req.query.error) : null;
  const githubEnabled = Boolean(GITHUB_CLIENT_ID);
  const googleEnabled = Boolean(GOOGLE_CLIENT_ID);

  const body = `<div class="page-card"><main class="card">
    <h1>Sign in to markco.dev</h1>
    <p>Collaborative markdown notebooks with code, AI, and publishing.</p>
    ${loggedOut ? '<div class="flash" style="margin-top:16px">You have been logged out.</div>' : ''}
    ${error ? `<div class="flash error" style="margin-top:16px">Login failed: ${error}</div>` : ''}

    <div class="stack">
      <a class="btn primary ${githubEnabled ? '' : 'disabled'}" href="${githubEnabled ? '/login/github' : '#'}">Continue with GitHub</a>
      <a class="btn ${googleEnabled ? '' : 'disabled'}" href="${googleEnabled ? '/login/google' : '#'}">Continue with Google ${googleEnabled ? '' : '<span class="pill">soon</span>'}</a>
    </div>

    <div class="divider"><span>or</span></div>

    <form class="email-form" action="/login/email" method="POST">
      <input type="email" name="email" placeholder="you@example.com" required autocomplete="email" class="input" />
      <button type="submit" class="btn">Send login link</button>
    </form>

    <div class="row">
      <a class="btn ghost" href="/sandbox">Try without an account</a>
    </div>

    <p class="meta">Domain: <code>${escapeHtml(DOMAIN)}</code></p>
  </main></div>`;

  return res.send(renderPage('markco.dev — Login', body));
});

// ── GET /login/github ─────────────────────────────────────────────────
router.get('/login/github', (req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(500).send('GitHub OAuth is not configured');
  }
  // If electron=1, remember it so completeLogin redirects to /auth/electron/success
  if (req.query.electron === '1') {
    res.cookie('electron_auth', '1', { httpOnly: true, maxAge: 600000, sameSite: 'lax' });
  }
  return res.redirect(githubOAuthUrl());
});

// ── GET /login/google ─────────────────────────────────────────────────
router.get('/login/google', (_req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).send('Google OAuth is not configured');
  }
  return res.redirect(googleOAuthUrl());
});

// ── GET /auth/electron/success — Electron app reads token from this page ──
router.get('/auth/electron/success', (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Missing token');

  // This page is only shown briefly in Electron's auth window.
  // Electron watches for this URL, extracts the token, and closes the window.
  res.type('html').send(`<!DOCTYPE html>
<html><head><title>Sign in successful</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d1117;color:#c9d1d9">
<div style="text-align:center">
<h1 style="color:#58a6ff">✓ Signed in to MarkCo</h1>
<p>You can close this window and return to the app.</p>
<p style="color:#484f58;font-size:12px">If this window doesn't close automatically, copy this token:</p>
<code id="token" style="color:#484f58;font-size:10px;word-break:break-all">${token}</code>
</div>
</body></html>`);
});

// ── GET /auth/callback/github ─────────────────────────────────────────
router.get('/auth/callback/github', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing OAuth code');

  try {
    const { user, token, expires_at: expiresAt } = await authService.githubAuth(code);
    return await completeLogin(res, user, token, expiresAt);
  } catch (err) {
    console.error('[callback/github] OAuth error:', err.message);
    return res.redirect('/login?error=github_oauth_failed');
  }
});

// ── GET /auth/callback/google ─────────────────────────────────────────
router.get('/auth/callback/google', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing OAuth code');

  try {
    const redirectUri = `${appProtocol()}://${DOMAIN}/auth/callback/google`;
    const { user, token, expires_at: expiresAt } = await authService.googleAuth(code, redirectUri);
    return await completeLogin(res, user, token, expiresAt);
  } catch (err) {
    console.error('[callback/google] OAuth error:', err.message);
    return res.redirect('/login?error=google_oauth_failed');
  }
});

// ── POST /login/email ─────────────────────────────────────────────────
router.post('/login/email', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.redirect('/login?error=missing_email');
  }

  try {
    await authService.sendMagicLink(email);
  } catch (err) {
    console.error('[login/email] Error:', err.message);
    const detail = err.data?.error || 'email_send_failed';
    return res.redirect(`/login?error=${encodeURIComponent(detail)}`);
  }

  const safeEmail = escapeHtml(email);
  const body = `<div class="page-card"><main class="card">
    <h1>Check your inbox</h1>
    <p>We sent a login link to <strong>${safeEmail}</strong>.</p>
    <p>Click the link in the email to sign in. It expires in 15 minutes.</p>
    <p class="meta" style="margin-top:24px">Didn't get it? Check your spam folder or <a href="/login">try again</a>.</p>
  </main></div>`;
  return res.send(renderPage('markco.dev — Check your email', body));
});

// ── GET /auth/email/verify ────────────────────────────────────────────
router.get('/auth/email/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.redirect('/login?error=missing_token');
  }

  try {
    const { user, token: sessionToken, expires_at: expiresAt } = await authService.verifyMagicLink(token);
    return await completeLogin(res, user, sessionToken, expiresAt);
  } catch (err) {
    console.error('[auth/email/verify] Error:', err.message);
    return res.redirect('/login?error=invalid_or_expired_link');
  }
});

// ── GET /dashboard ────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, async (req, res) => {
  const user = req.user;
  let editor = getEditorInfo(user.id);

  if (!editor) {
    try {
      await onUserLogin(user);
      editor = getEditorInfo(user.id);
    } catch (err) {
      console.error(`[dashboard] Failed to auto-start editor for ${user.id}: ${err.message}`);
    }
  }

  if (htmlMode(req)) {
    const safeName = escapeHtml(user.name || user.email || user.username || 'friend');
    const editorUrl = editor ? `/u/${user.id}/` : null;
    const statusBadge = editor
      ? '<span class="pill">workspace ready</span>'
      : '<span class="pill" style="border-color:#e65100;background:rgba(255,152,0,0.08);color:#ff9800">starting…</span>';

    const body = `<div class="page-card"><main class="card">
      <h1>Welcome back, ${safeName}</h1>
      <p>Your workspace is running on markco.dev. ${statusBadge}</p>

      <div class="row" style="margin-top:24px">
        ${editorUrl
    ? `<a class="btn primary" href="${editorUrl}">Open Editor</a>`
    : '<button class="btn" disabled>Starting workspace...</button>'}
        <a class="btn ghost" href="/sandbox">Open Guest Sandbox</a>
      </div>

      <div class="row" style="margin-top:10px">
        <form method="post" action="/logout" id="logout-form" style="margin:0">
          <button class="btn" type="submit">Logout</button>
        </form>
        <a class="btn ghost" href="/account-delete">Delete account</a>
      </div>

      <p class="meta">Plan: <code>${escapeHtml(user.plan || 'free')}</code></p>
    </main></div>

    <script>
      document.getElementById('logout-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        await fetch('/logout', { method: 'POST', credentials: 'include' });
        window.location.href = '/login?logged_out=1';
      });
    </script>`;

    return res.send(renderPage('markco.dev — Dashboard', body));
  }

  return res.json({
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      name: user.name,
      plan: user.plan,
    },
    editor: editor
      ? {
        host: editor.host,
        editorPort: editor.editorPort,
        runtimePort: editor.runtimePort,
      }
      : null,
  });
});

// ── GET /api/sync/documents ─────────────────────────────────────────
// Proxy to sync-relay document API for the authenticated user.
// Query:
//   ?project=<name>   (optional)
//   ?content=1        include text content
//   ?yjs=1            include Yjs state (base64)
router.get('/api/sync/documents', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const project = req.query.project ? String(req.query.project) : null;

  const qs = new URLSearchParams();
  if (String(req.query.content || '') === '1') qs.set('content', '1');
  if (String(req.query.yjs || '') === '1') qs.set('yjs', '1');

  let relayUrl = `http://127.0.0.1:${SYNC_RELAY_PORT}/api/documents/${encodeURIComponent(userId)}`;
  if (project) relayUrl += `/${encodeURIComponent(project)}`;
  const query = qs.toString();
  if (query) relayUrl += `?${query}`;

  try {
    const upstream = await fetch(relayUrl, {
      headers: {
        'X-User-Id': userId,
      },
      signal: AbortSignal.timeout(15000),
    });

    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(body);
  } catch (err) {
    console.error('[api/sync/documents] proxy error:', err.message);
    return res.status(502).json({ error: 'sync-relay unavailable' });
  }
});

// ── GET /api/catalog ────────────────────────────────────────────────
// Proxy to sync-relay catalog API — list all machines + their file manifests.
// Query:
//   ?project=<name>   (optional) filter to a specific project
router.get('/api/catalog', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const project = req.query.project ? String(req.query.project) : null;

  let relayUrl = `http://127.0.0.1:${SYNC_RELAY_PORT}/api/catalog/${encodeURIComponent(userId)}`;
  if (project) relayUrl += `?project=${encodeURIComponent(project)}`;

  try {
    const upstream = await fetch(relayUrl, {
      headers: { 'X-User-Id': userId },
      signal: AbortSignal.timeout(15000),
    });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(body);
  } catch (err) {
    console.error('[api/catalog] proxy error:', err.message);
    return res.status(502).json({ error: 'sync-relay unavailable' });
  }
});

// ── GET /api/machines ──────────────────────────────────────────────
// Proxy to sync-relay machines API — list connected machines with status.
router.get('/api/machines', requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const upstream = await fetch(
      `http://127.0.0.1:${SYNC_RELAY_PORT}/api/machines/${encodeURIComponent(userId)}`,
      {
        headers: { 'X-User-Id': userId },
        signal: AbortSignal.timeout(10000),
      }
    );
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(body);
  } catch (err) {
    console.error('[api/machines] proxy error:', err.message);
    return res.status(502).json({ error: 'sync-relay unavailable' });
  }
});

// ── GET /api/machines/active ────────────────────────────────────────
// Get the active runtime machine for the current user.
router.get('/api/machines/active', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const upstream = await fetch(
      `http://127.0.0.1:${SYNC_RELAY_PORT}/api/tunnel/${encodeURIComponent(userId)}/active`,
      { headers: { 'X-User-Id': userId }, signal: AbortSignal.timeout(10000) }
    );
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(body);
  } catch (err) {
    console.error('[api/machines/active] proxy error:', err.message);
    return res.status(502).json({ error: 'sync-relay unavailable' });
  }
});

// ── POST /api/machines/active ──────────────────────────────────────
// Set the active runtime machine. Body: { machineId: "..." } or { machineId: null } for auto.
router.post('/api/machines/active', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const upstream = await fetch(
      `http://127.0.0.1:${SYNC_RELAY_PORT}/api/tunnel/${encodeURIComponent(userId)}/active`,
      {
        method: 'POST',
        headers: {
          'X-User-Id': userId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ machineId: req.body?.machineId ?? null }),
        signal: AbortSignal.timeout(10000),
      }
    );
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(body);
  } catch (err) {
    console.error('[api/machines/active] proxy error:', err.message);
    return res.status(502).json({ error: 'sync-relay unavailable' });
  }
});

// ── POST /api/runtime/recover ──────────────────────────────────────
// Force-recover the current user's Python runtime and hot-update editor routing.
router.post('/api/runtime/recover', requireAuth, async (req, res) => {
  const user = req.user;
  let editor = getEditorInfo(user.id);

  // Ensure editor exists
  if (!editor) {
    try {
      await onUserLogin(user);
      editor = getEditorInfo(user.id);
    } catch (err) {
      console.error('[runtime:recover] Failed to start editor:', err.message);
      return res.status(500).json({ error: 'Editor unavailable' });
    }
  }

  // Fast path: if current runtime responds, no-op
  if (editor?.runtimePort) {
    try {
      const caps = await fetch(`http://127.0.0.1:${editor.runtimePort}/mrp/v1/capabilities`, {
        signal: AbortSignal.timeout(3000),
      });
      if (caps.ok) {
        return res.json({ ok: true, recovered: false, port: editor.runtimePort });
      }
    } catch {
      // continue to recovery path
    }
  }

  try {
    const probeRuntime = async (port, timeoutMs = 20000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const caps = await fetch(`http://127.0.0.1:${port}/mrp/v1/capabilities`, {
            signal: AbortSignal.timeout(3000),
          });
          if (caps.ok) return true;
        } catch {
          // keep polling until timeout
        }
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    };

    let runtime = await computeManager.startRuntime(user.id, user.plan || 'free');

    // If compute-manager returned a "running" runtime that still doesn't answer,
    // force a fresh runtime once.
    let reachable = false;
    try {
      reachable = await probeRuntime(runtime.port);
    } catch {
      reachable = false;
    }

    if (!reachable) {
      console.warn(`[runtime:recover] Runtime ${runtime.container_name} not reachable on ${runtime.port}, recreating`);
      try {
        await computeManager.stopRuntime(user.id);
      } catch {
        // best effort
      }
      runtime = await computeManager.startRuntime(user.id, user.plan || 'free');

      reachable = false;
      try {
        reachable = await probeRuntime(runtime.port);
      } catch {
        reachable = false;
      }
      if (!reachable) {
        throw new Error(`Recovered runtime is still unreachable on port ${runtime.port}`);
      }
    }

    // Update in-memory editor mapping
    if (editor) {
      editor.runtimeId = runtime.runtime_id;
      editor.runtimeContainer = runtime.container_name;
      editor.runtimePort = runtime.port;
      editor.plan = user.plan || 'free';
    }

    // Tell mrmd-server to route Python requests to the new runtime port
    await notifyRuntimePortChange(user.id, runtime.port, runtime.host || 'localhost');

    return res.json({
      ok: true,
      recovered: true,
      runtime: {
        id: runtime.runtime_id,
        container_name: runtime.container_name,
        host: runtime.host,
        port: runtime.port,
        state: runtime.state,
      },
    });
  } catch (err) {
    console.error('[runtime:recover] Recovery failed:', err.message);
    return res.status(502).json({ error: 'Runtime recovery failed', detail: err.message });
  }
});

// ── POST /api/account/delete ────────────────────────────────────────
router.post('/api/account/delete', requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    await onUserLogout(userId);
  } catch (err) {
    console.warn('[account-delete] Lifecycle cleanup warning:', err.message);
  }

  try {
    await authService.deleteAccount(req.sessionToken);
  } catch (err) {
    console.error('[account-delete] Auth delete failed:', err.message);
    return res.status(502).json({ error: 'Unable to delete account right now' });
  }

  clearSessionCookie(res);

  const dataDir = process.env.DATA_DIR || '/data/users';
  const userDir = `${dataDir}/${userId}`;
  try {
    await rm(userDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('[account-delete] Failed to remove user directory:', err.message);
  }

  return res.json({ ok: true, deleted_user_id: userId });
});

// ── POST /logout & /api/logout ───────────────────────────────────────
async function handleLogout(req, res) {
  const token = extractToken(req);
  let userId = null;

  if (token) {
    try {
      const { user } = await authService.validate(token);
      userId = user?.id || null;
    } catch {
      // already invalid/expired
    }

    try {
      await authService.logout(token);
    } catch (err) {
      if (err.status !== 401) {
        console.warn('[logout] Auth service logout warning:', err.message);
      }
    }
  }

  if (userId) {
    try {
      await onUserLogout(userId);
    } catch (err) {
      console.warn('[logout] User lifecycle warning:', err.message);
    }
  }

  clearSessionCookie(res);

  if (htmlMode(req)) {
    return res.redirect('/login?logged_out=1');
  }
  return res.json({ ok: true });
}

router.post('/logout', handleLogout);
router.post('/api/logout', handleLogout);

// ── Sandbox AI proxy (guest mode, BYO API keys) ──────────────────────
const SANDBOX_KEY_TEST_URLS = {
  anthropic: 'https://api.anthropic.com/v1/models',
  openai: 'https://api.openai.com/v1/models',
  groq: 'https://api.groq.com/openai/v1/models',
  gemini: 'https://generativelanguage.googleapis.com/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
};

router.get('/api/ai/key-test/:provider', async (req, res) => {
  const provider = String(req.params.provider || '').toLowerCase();
  const baseUrl = SANDBOX_KEY_TEST_URLS[provider];

  console.log(`[key-test] provider=${provider} hasAuth=${!!req.headers.authorization} hasXApiKey=${!!req.headers['x-api-key']} hasQueryKey=${!!req.query.key}`);

  if (!baseUrl) {
    return res.status(400).json({ error: `Unsupported provider: ${provider}` });
  }

  let targetUrl = baseUrl;
  const headers = {
    Accept: 'application/json',
  };

  if (provider === 'gemini') {
    const key = req.query.key;
    if (!key) {
      return res.status(400).json({ error: 'Missing Gemini API key' });
    }
    targetUrl = `${baseUrl}?key=${encodeURIComponent(String(key))}`;
  } else if (provider === 'anthropic') {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(400).json({ error: 'Missing Anthropic API key header' });
    }
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
  } else {
    const auth = req.headers.authorization;
    if (!auth) {
      return res.status(400).json({ error: 'Missing Authorization header' });
    }
    headers.Authorization = auth;
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15000),
    });

    const body = await upstream.text();
    console.log(`[key-test] provider=${provider} upstream=${upstream.status} bodyLen=${body?.length}`);
    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    return res.send(body || JSON.stringify({ ok: upstream.ok, status: upstream.status }));
  } catch (err) {
    console.error(`[key-test] provider=${provider} error: ${err.message}`);
    return res.status(502).json({ error: 'Provider test failed', detail: err.message });
  }
});

router.get('/api/ai/status', async (_req, res) => {
  try {
    const ping = await fetch(`${SANDBOX_AI_UPSTREAM}/programs`, {
      signal: AbortSignal.timeout(5000),
    });

    return res.status(ping.ok ? 200 : 503).json({
      url: '/api/ai/proxy',
      managed: false,
      running: ping.ok,
      default_juice_level: 0,
      mode: 'sandbox-proxy',
    });
  } catch {
    return res.status(503).json({
      url: '/api/ai/proxy',
      managed: false,
      running: false,
      default_juice_level: 0,
      mode: 'sandbox-proxy',
      error: 'upstream unavailable',
    });
  }
});

router.get('/api/ai/programs', async (req, res) => {
  return proxySandboxAi(req, res, '/programs');
});

router.all('/api/ai/proxy', async (_req, res) => {
  return res.json({
    ok: true,
    mode: 'sandbox-proxy',
  });
});

router.all('/api/ai/proxy/*', async (req, res) => {
  const path = `/${req.params[0] || ''}`;
  const query = req.originalUrl.includes('?')
    ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
    : '';
  return proxySandboxAi(req, res, `${path}${query}`);
});

// Optional compatibility with AiClient(/api/ai/:program)
router.post('/api/ai/:program', async (req, res) => {
  return proxySandboxAi(req, res, `/${req.params.program}`);
});

router.post('/api/ai/:program/stream', async (req, res) => {
  return proxySandboxAi(req, res, `/${req.params.program}/stream`);
});

// ── GET /sandbox (guest local mode, no auth) ─────────────────────────
// Serves the real mrmd editor index.html with browser-shim.js + sandbox-bridge.js
// instead of http-shim.js + sync server. Same app, different backend.
router.get('/sandbox', async (_req, res) => {
  // Read the canonical editor index.html
  const editorHtmlPath = process.env.EDITOR_HTML_PATH
    || '/opt/markco/editor-build/mrmd-electron/index.html';

  let html;
  try {
    html = await readFile(editorHtmlPath, 'utf8');
  } catch (err) {
    console.error('[sandbox] Failed to read editor index.html:', err.message);
    return res.status(500).send('Sandbox unavailable: editor assets not found');
  }

  // === Transform index.html for sandbox mode ===

  // 1. Replace CSP to allow Pyodide CDN, AI API endpoints, and sandbox assets
  html = html.replace(
    /<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' https: http: data: blob: ws: wss:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://esm.sh https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://webr.r-wasm.org blob:; font-src 'self' https://fonts.gstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https:; img-src 'self' data: blob: https: http:; frame-src 'self' blob: data:; worker-src 'self' blob: https://cdn.jsdelivr.net https://webr.r-wasm.org;">`
  );

  // 2. Replace editor script path
  html = html.replace(
    /src="\.\.\/mrmd-editor\/dist\/mrmd\.iife\.js"/,
    'src="/static/mrmd.iife.js"'
  );

  // 3. Replace asset paths (fonts, icons)
  html = html.replace(/url\('\.\/assets\/fonts\//g, "url('/static/fonts/");
  html = html.replace(/href="\.\/assets\//g, 'href="/static/assets/');

  // 4. Replace xterm paths
  html = html.replace(/href="\.\/node_modules\/xterm\/css\//g, 'href="/static/xterm/');
  html = html.replace(/src="\.\/node_modules\/xterm\/lib\//g, 'src="/static/xterm/');
  html = html.replace(/src="\.\/node_modules\/xterm-addon-fit\/lib\//g, 'src="/static/xterm/');
  html = html.replace(/src="\.\/node_modules\/xterm-addon-web-links\/lib\//g, 'src="/static/xterm/');

  // 5. Inject browser-shim.js BEFORE the mrmd editor script, runtimes AFTER
  html = html.replace(
    '<script src="/static/mrmd.iife.js"></script>',
    `<!-- Sandbox shim: IndexedDB-backed electronAPI -->
  <script src="/static/browser-shim.js?v=${Date.now()}"></script>

  <script src="/static/mrmd.iife.js"></script>

  <!-- Wasm runtimes (lazy-loaded on first use) -->
  <script src="/static/pyodide-runtime.js"></script>
  <script src="/static/webr-runtime.js"></script>

  <!-- Sandbox bridge: patches mrmd.drive() for local editing, registers runtimes -->
  <script src="/static/sandbox-bridge.js?v=${Date.now()}"></script>

  <!-- Sandbox AI fallback: re-connect AI client if initial hook races -->
  <script>
    (() => {
      if (!window.MRMD_SANDBOX) return;

      const ensureSandboxAiConnected = async () => {
        try {
          if (typeof connectAiServer !== 'function') return;
          const ai = await window.electronAPI?.getAi?.();
          if (ai?.success && ai.port) {
            connectAiServer('http://127.0.0.1:' + ai.port);
            if (typeof updateAiStatus === 'function') updateAiStatus('ready');
          }
        } catch (err) {
          console.warn('[sandbox-ai] reconnect failed:', err?.message || err);
        }
      };

      window.addEventListener('DOMContentLoaded', () => setTimeout(ensureSandboxAiConnected, 300));
      window.addEventListener('load', () => setTimeout(ensureSandboxAiConnected, 1200));
      window.addEventListener('focus', () => setTimeout(ensureSandboxAiConnected, 100));
      window.addEventListener('mrmd:sandbox-settings-changed', () => setTimeout(ensureSandboxAiConnected, 50));
    })();
  </script>`
  );

  // 6. Update page title
  html = html.replace(/<title>mrmd<\/title>/, '<title>markco.dev — Sandbox</title>');

  // 6b. Inject sandbox sign-in CTA (replaces cloud account avatar in logged-in mode)
  html = html.replace(
    '</head>',
    `<!-- [sandbox] Sign-in CTA -->
<style>
  /* ── Shift search+AI buttons left to make room for CTA ── */
  .titlebar-mobile-actions {
    right: 140px !important;
  }

  /* ── Desktop: pill button in titlebar ── */
  .sandbox-cta {
    position: absolute;
    right: 48px;
    top: 50%;
    transform: translateY(-50%);
    -webkit-app-region: no-drag;
    z-index: 100;
  }
  .sandbox-cta-btn {
    height: 26px;
    border-radius: 13px;
    border: 1.5px solid var(--accent, #58a6ff);
    cursor: pointer;
    background: transparent;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    transition: background 0.15s, border-color 0.15s;
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--accent, #58a6ff);
    white-space: nowrap;
    letter-spacing: 0.2px;
  }
  .sandbox-cta-btn:hover {
    background: var(--accent, #58a6ff);
    color: var(--bg, #0d1117);
  }
  .sandbox-cta-btn svg { flex-shrink: 0; }
  .sandbox-cta-label { /* text beside icon */ }

  /* ── Dropdown panel ── */
  .sandbox-cta-dropdown {
    display: none;
    position: fixed;
    top: 56px;
    right: 12px;
    background: var(--bg-secondary, #161b22);
    border: 1px solid var(--border, #30363d);
    border-radius: 10px;
    padding: 0;
    width: 280px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    z-index: 10000;
    overflow: hidden;
  }
  .sandbox-cta-dropdown.open { display: block; }

  /* Scrim (enabled on mobile only) */
  .sandbox-cta-scrim {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.4);
    z-index: 9999;
  }
  .sandbox-cta-scrim.open { display: none; }
  .sandbox-cta-header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border, #30363d);
  }
  .sandbox-cta-current {
    display: flex; flex-direction: column; gap: 6px;
  }
  .sandbox-cta-badge {
    display: inline-block;
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--accent, #58a6ff);
    background: rgba(88, 166, 255, 0.1);
    border: 1px solid rgba(88, 166, 255, 0.2);
    border-radius: 4px;
    padding: 2px 7px;
    width: fit-content;
  }
  .sandbox-cta-current p {
    margin: 0; font-size: 12px; line-height: 1.5;
    color: var(--text-muted, #8b949e);
  }
  .sandbox-cta-upgrade {
    padding: 12px 16px 10px;
    border-bottom: 1px solid var(--border, #30363d);
  }
  .sandbox-cta-upgrade h3 {
    margin: 0 0 8px; font-size: 13px; font-weight: 600;
    color: var(--text, #c9d1d9);
  }
  .sandbox-cta-features {
    list-style: none; margin: 0; padding: 0;
  }
  .sandbox-cta-features li {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; color: var(--text-muted, #8b949e); padding: 3px 0;
  }
  .sandbox-cta-features li svg {
    flex-shrink: 0; color: var(--success, #3fb950);
  }
  .sandbox-cta-actions {
    padding: 12px 16px; display: flex; flex-direction: column; gap: 6px;
    align-items: center;
  }
  .sandbox-cta-actions a {
    display: block; text-align: center; padding: 10px 0; border-radius: 8px;
    font-size: 14px; font-weight: 600; text-decoration: none;
    font-family: inherit; transition: opacity 0.15s;
    width: 100%;
  }
  .sandbox-cta-actions a:hover { opacity: 0.85; }
  .sandbox-cta-actions .primary-action {
    background: var(--accent, #58a6ff); color: var(--bg, #0d1117);
  }
  .sandbox-cta-free {
    font-size: 11px; color: var(--text-dim, #6e7681);
    font-weight: 400;
  }

  /* ── Mobile / touch: icon-only button + bottom sheet ── */
  @media (max-width: 900px), (hover: none) and (pointer: coarse) {
    /* Reset the desktop shift — mobile layout is flex-based */
    .titlebar-mobile-actions {
      right: auto !important;
      position: static !important;
      transform: none !important;
    }
    .sandbox-cta {
      position: static;
      transform: none;
      flex-shrink: 0;
      order: 10;
    }
    .sandbox-cta-btn {
      width: 34px; height: 34px;
      border-radius: 50%;
      padding: 0;
      justify-content: center;
      border-width: 1.5px;
    }
    .sandbox-cta-label { display: none; }

    .sandbox-cta-dropdown {
      display: block;
      position: fixed;
      top: auto;
      bottom: 0;
      left: 0;
      right: 0;
      width: 100%;
      max-width: 100%;
      border-radius: 16px 16px 0 0;
      border: none;
      border-top: 1px solid var(--border, #30363d);
      box-shadow: none;
      z-index: 10000;
      padding-bottom: env(safe-area-inset-bottom, 0px);
      visibility: hidden;
      opacity: 0;
      transform: translateY(100%);
      pointer-events: none;
      transition: transform 0.25s cubic-bezier(0.2, 0, 0, 1), opacity 0.2s ease;
    }
    .sandbox-cta-dropdown.open {
      visibility: visible;
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }

    .sandbox-cta-scrim.open {
      display: block;
      animation: sandbox-fade-in 0.2s ease;
    }
    @keyframes sandbox-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .sandbox-cta-header {
      padding: 20px 20px 14px;
      position: relative;
    }
    /* Drag handle */
    .sandbox-cta-header::before {
      content: '';
      position: absolute;
      top: 8px; left: 50%; transform: translateX(-50%);
      width: 36px; height: 4px;
      background: var(--text-dim, #6e7681);
      border-radius: 2px; opacity: 0.4;
    }
    .sandbox-cta-badge { margin-top: 4px; }
    .sandbox-cta-current p { font-size: 14px; line-height: 1.5; }
    .sandbox-cta-upgrade { padding: 14px 20px 12px; }
    .sandbox-cta-upgrade h3 { font-size: 15px; }
    .sandbox-cta-features li { font-size: 14px; padding: 5px 0; min-height: 32px; }
    .sandbox-cta-actions { padding: 16px 20px 20px; }
    .sandbox-cta-actions a {
      padding: 14px 0; border-radius: 12px; font-size: 16px;
      min-height: 48px; display: flex; align-items: center; justify-content: center;
    }
    .sandbox-cta-free { font-size: 12px; padding-top: 2px; }
  }
</style>
<script>
(function() {
  var checkSvg = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 8.5l4 4 8-9"/></svg>';
  var mobileSheetQuery = '(max-width: 900px), (hover: none) and (pointer: coarse)';

  function shouldUseMobileSheet() {
    try {
      return window.matchMedia(mobileSheetQuery).matches;
    } catch (_err) {
      return window.innerWidth <= 900;
    }
  }

  function initSandboxCta() {
    var titlebar = document.querySelector('.titlebar');
    if (!titlebar || document.querySelector('.sandbox-cta')) return;

    var c = document.createElement('div');
    c.className = 'sandbox-cta';
    c.innerHTML =
      '<button class="sandbox-cta-btn" title="Sign in to markco.dev" aria-haspopup="dialog" aria-expanded="false">' +
        '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0a8 8 0 110 16A8 8 0 018 0zm0 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 3a2.5 2.5 0 110 5 2.5 2.5 0 010-5zm0 6.5c2.5 0 4.5 1.2 4.5 2.5v.5h-9v-.5c0-1.3 2-2.5 4.5-2.5z"/></svg>' +
        '<span class="sandbox-cta-label">Sign in</span>' +
      '</button>';

    var dropdown = document.createElement('div');
    dropdown.className = 'sandbox-cta-dropdown';
    dropdown.innerHTML =
      '<div class="sandbox-cta-header">' +
        '<div class="sandbox-cta-current">' +
          '<span class="sandbox-cta-badge">Sandbox</span>' +
          '<p>Your work is saved in this browser\u2019s local storage. It stays here as long as you don\u2019t clear your browser data.</p>' +
        '</div>' +
      '</div>' +
      '<div class="sandbox-cta-upgrade">' +
        '<h3>Sign in for more</h3>' +
        '<ul class="sandbox-cta-features">' +
          '<li>' + checkSvg + 'Cloud sync across all your devices</li>' +
          '<li>' + checkSvg + 'Bash, terminal &amp; Julia runtimes</li>' +
          '<li>' + checkSvg + 'Real-time collaboration</li>' +
          '<li>' + checkSvg + 'Publish notebooks to the web</li>' +
        '</ul>' +
      '</div>' +
      '<div class="sandbox-cta-actions">' +
        '<a href="/login" class="primary-action">Sign in / Sign up</a>' +
        '<span class="sandbox-cta-free">Free \u2014 no credit card</span>' +
      '</div>';

    var scrim = document.createElement('div');
    scrim.className = 'sandbox-cta-scrim';

    titlebar.appendChild(c);
    document.body.appendChild(scrim);
    document.body.appendChild(dropdown);

    var btn = c.querySelector('.sandbox-cta-btn');

    function positionDesktopDropdown() {
      if (shouldUseMobileSheet()) return;
      var rect = btn.getBoundingClientRect();
      dropdown.style.top = Math.round(rect.bottom + 8) + 'px';
      dropdown.style.right = Math.max(8, Math.round(window.innerWidth - rect.right)) + 'px';
      dropdown.style.left = 'auto';
    }

    function openDropdown() {
      positionDesktopDropdown();
      dropdown.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      if (shouldUseMobileSheet()) {
        scrim.classList.add('open');
      }
    }

    function closeDropdown() {
      dropdown.classList.remove('open');
      scrim.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }

    btn.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      if (dropdown.classList.contains('open')) {
        closeDropdown();
      } else {
        openDropdown();
      }
    });

    scrim.addEventListener('click', closeDropdown);

    document.addEventListener('click', function(e) {
      if (!dropdown.classList.contains('open')) return;
      if (c.contains(e.target) || dropdown.contains(e.target)) return;
      closeDropdown();
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeDropdown();
    });

    window.addEventListener('resize', function() {
      if (dropdown.classList.contains('open')) {
        if (shouldUseMobileSheet()) {
          dropdown.style.top = '';
          dropdown.style.right = '';
          dropdown.style.left = '';
          scrim.classList.add('open');
        } else {
          scrim.classList.remove('open');
          positionDesktopDropdown();
        }
      }
    });

    dropdown.addEventListener('click', function(e) {
      e.stopPropagation();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSandboxCta);
  } else {
    setTimeout(initSandboxCta, 300);
  }
})();
</script>
</head>`
  );

  // 7. Inject sandbox auto-open: open welcome.md instead of showing file picker
  //    This replaces the setTimeout(showFilePicker, 100) at the end of init()
  html = html.replace(
    'setTimeout(showFilePicker, 100);',
    `// [sandbox] Auto-open welcome.md instead of showing file picker
      if (window.MRMD_SANDBOX) {
        setTimeout(() => openFile('/sandbox/welcome.md'), 150);
      } else {
        setTimeout(showFilePicker, 100);
      }`
  );

  // Inject PWA tags + optional analytics
  html = injectPwaAndAnalyticsIntoHtml(html);

  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  return res.type('html').send(html);
});

// (Old textarea sandbox removed — replaced by full editor sandbox above)

// ── POST /projects/import ─────────────────────────────────────────────
router.post('/projects/import', requireAuth, async (req, res) => {
  const { repo_url: repoUrl, name } = req.body;
  if (!repoUrl) {
    return res.status(400).json({ error: 'repo_url required' });
  }

  const userId = req.user.id;
  const projectName = name || repoUrl.split('/').pop().replace('.git', '');
  const dataDir = process.env.DATA_DIR || '/data/users';
  const projectDir = `${dataDir}/${userId}/Projects/${projectName}`;

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    await exec('mkdir', ['-p', `${dataDir}/${userId}/Projects`]);
    await exec('git', ['clone', '--depth', '1', repoUrl, projectDir], { timeout: 60000 });

    return res.status(201).json({
      project: projectName,
      path: projectDir,
      url: `/u/${userId}/?project=${encodeURIComponent(projectName)}`,
    });
  } catch (err) {
    console.error('[import] Clone error:', err.message);
    return res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

// ── User editor reverse proxy ─────────────────────────────────────────
router.use('/u/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;

  if (userId !== req.user.id) {
    return res.status(403).send('Forbidden');
  }

  let editor = getEditorInfo(userId);
  if (!editor) {
    try {
      await onUserLogin(req.user);
      editor = getEditorInfo(userId);
    } catch (err) {
      console.error(`[proxy] Failed to start editor for ${userId}: ${err.message}`);
    }
  }

  if (!editor) {
    return res.redirect('/dashboard');
  }

  const targetUrl = `http://localhost:${editor.editorPort}${req.url}`;

  try {
    const headers = { ...req.headers };
    delete headers.host;
    headers['x-forwarded-for'] = req.ip;
    headers['x-forwarded-proto'] = req.protocol;

    const proxyRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
      redirect: 'manual',
    });

    res.status(proxyRes.status);
    proxyRes.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    const contentType = (proxyRes.headers.get('content-type') || '').toLowerCase();
    const buffer = Buffer.from(await proxyRes.arrayBuffer());

    if (contentType.includes('text/html')) {
      const html = injectPwaAndAnalyticsIntoHtml(buffer.toString('utf8'));
      return res.type('html').send(html);
    }

    return res.send(buffer);
  } catch (err) {
    console.error(`[proxy] Error proxying to ${targetUrl}: ${err.message}`);
    res.status(502).send('Editor proxy error');
  }
});

export default router;
