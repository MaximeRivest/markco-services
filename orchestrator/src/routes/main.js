/**
 * Main user-facing routes for the orchestrator.
 * Handles auth flow, dashboard, and user editor proxying.
 */

import { Router } from 'express';
import { authService } from '../service-client.js';
import { onUserLogin, onUserLogout, getEditorInfo } from '../user-lifecycle.js';

const router = Router();

const DOMAIN = process.env.DOMAIN || 'markco.dev';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const IS_LOCAL_DOMAIN = /^(\d|localhost)/.test(DOMAIN);

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

  try {
    await onUserLogin(user);
  } catch (err) {
    console.error(`[callback] Failed to start editor for ${user.id}: ${err.message}`);
  }

  res.redirect('/dashboard');
}

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
      <button class="btn disabled" type="button">Continue with Email Link <span class="pill">soon</span></button>
    </div>

    <div class="row">
      <a class="btn ghost" href="/sandbox">Try without an account</a>
    </div>

    <p class="meta">Domain: <code>${escapeHtml(DOMAIN)}</code></p>
  </main></div>`;

  return res.send(renderPage('markco.dev — Login', body));
});

// ── GET /login/github ─────────────────────────────────────────────────
router.get('/login/github', (_req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(500).send('GitHub OAuth is not configured');
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

// ── GET /sandbox (guest local mode, no auth) ─────────────────────────
// Serves the real mrmd editor index.html with browser-shim.js + sandbox-bridge.js
// instead of http-shim.js + sync server. Same app, different backend.
router.get('/sandbox', async (_req, res) => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

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
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:; connect-src 'self' https: http: data: blob: ws: wss:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://esm.sh https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com blob:; font-src 'self' https://fonts.gstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https:; img-src 'self' data: blob: https: http:; frame-src 'self' blob: data:; worker-src 'self' blob:;">`
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

  // 5. Inject browser-shim.js BEFORE the mrmd editor script
  html = html.replace(
    '<script src="/static/mrmd.iife.js"></script>',
    `<!-- Sandbox shim: IndexedDB-backed electronAPI -->
  <script src="/static/browser-shim.js"></script>

  <script src="/static/mrmd.iife.js"></script>

  <!-- Sandbox bridge: patches mrmd.drive() for local editing -->
  <script src="/static/sandbox-bridge.js"></script>`
  );

  // 6. Update page title
  html = html.replace(/<title>mrmd<\/title>/, '<title>markco.dev — Sandbox</title>');

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
      if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    const body = await proxyRes.arrayBuffer();
    res.send(Buffer.from(body));
  } catch (err) {
    console.error(`[proxy] Error proxying to ${targetUrl}: ${err.message}`);
    res.status(502).send('Editor proxy error');
  }
});

export default router;
