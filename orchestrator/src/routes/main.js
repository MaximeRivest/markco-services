/**
 * Main user-facing routes for the orchestrator.
 * Handles OAuth flow, dashboard, project import.
 */

import { Router } from 'express';
import { authService } from '../service-client.js';
import { onUserLogin, onUserLogout, getEditorInfo } from '../user-lifecycle.js';

const router = Router();

const DOMAIN = process.env.DOMAIN || 'feuille.dev';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;

/**
 * Auth middleware for orchestrator routes.
 * Validates token via auth-service and attaches req.user.
 */
async function requireAuth(req, res, next) {
  const token = req.query.token
    || req.cookies?.session_token
    || req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.redirect('/login');
  }

  try {
    const { user } = await authService.validate(token);
    req.user = user;
    req.sessionToken = token;
    // Set/refresh cookie if authenticating via query param or header
    if (req.query.token || req.headers.authorization) {
      res.cookie('session_token', token, {
        httpOnly: true,
        secure: !DOMAIN.match(/^(\d|localhost)/),
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
    }
    next();
  } catch (err) {
    if (err.status === 401) {
      return res.redirect('/login');
    }
    console.error('[auth] Validation error:', err.message);
    res.status(500).json({ error: 'Auth service unavailable' });
  }
}

// ── GET / ─────────────────────────────────────────────────────────────
router.get('/', requireAuth, (_req, res) => {
  res.redirect('/dashboard');
});

// ── GET /login ────────────────────────────────────────────────────────
router.get('/login', (_req, res) => {
  if (!GITHUB_CLIENT_ID) {
    return res.status(500).json({ error: 'GITHUB_CLIENT_ID not configured' });
  }

  const protocol = DOMAIN.match(/^(\d|localhost)/) ? 'http' : 'https';
  const redirectUri = `${protocol}://${DOMAIN}/auth/callback/github`;
  const scope = 'read:user user:email';
  const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`;
  res.redirect(url);
});

// ── GET /auth/callback/github ─────────────────────────────────────────
router.get('/auth/callback/github', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing OAuth code');
  }

  try {
    // Exchange code via auth-service
    const { user, token, expires_at } = await authService.githubAuth(code);

    // Set session cookie
    res.cookie('session_token', token, {
      httpOnly: true,
      secure: !DOMAIN.match(/^(\d|localhost)/),
      sameSite: 'lax',
      expires: new Date(expires_at),
      domain: DOMAIN === 'localhost' ? undefined : `.${DOMAIN}`,
    });

    // Start editor container for user
    try {
      await onUserLogin(user);
    } catch (err) {
      console.error(`[callback] Failed to start editor for ${user.id}: ${err.message}`);
      // Continue to dashboard anyway; they can retry
    }

    res.redirect('/dashboard');
  } catch (err) {
    console.error('[callback] OAuth error:', err.message);
    res.status(500).send('Authentication failed. Please try again.');
  }
});

// ── GET /dashboard ────────────────────────────────────────────────────
router.get('/dashboard', requireAuth, async (req, res) => {
  const user = req.user;
  let editor = getEditorInfo(user.id);

  // Auto-start editor if not running
  if (!editor) {
    try {
      await onUserLogin(user);
      editor = getEditorInfo(user.id);
    } catch (err) {
      console.error(`[dashboard] Failed to auto-start editor for ${user.id}: ${err.message}`);
    }
  }

  // Return JSON for API clients, HTML for browsers
  if (req.accepts('html') && !req.headers['x-requested-with']) {
    const editorUrl = editor ? `/u/${user.id}/` : null;
    const statusMsg = editor
      ? `<p>Editor running on port ${editor.editorPort}, runtime on port ${editor.runtimePort}</p>
         <p><a href="${editorUrl}" style="font-size:1.2em;font-weight:bold">Open Editor</a></p>`
      : '<p>Editor failed to start. Check server logs.</p>';

    res.send(`<!DOCTYPE html>
<html>
<head><title>feuille.dev - Dashboard</title></head>
<body>
  <h1>Welcome, ${user.name || user.email}</h1>
  <p>Plan: ${user.plan || 'free'}</p>
  ${statusMsg}
  <form method="POST" action="/auth/logout" id="logout-form">
    <button type="submit">Logout</button>
  </form>
  <script>
    document.getElementById('logout-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
      window.location.href = '/login';
    });
  </script>
</body>
</html>`);
  } else {
    res.json({
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        plan: user.plan,
      },
      editor: editor ? { host: editor.host, editorPort: editor.editorPort, runtimePort: editor.runtimePort } : null,
    });
  }
});

// ── POST /auth/logout ─────────────────────────────────────────────────
router.post('/auth/logout', requireAuth, async (req, res) => {
  try {
    await authService.logout(req.sessionToken);
    await onUserLogout(req.user.id);
    res.clearCookie('session_token');
    res.json({ ok: true });
  } catch (err) {
    console.error('[logout] Error:', err.message);
    res.status(500).json({ error: 'Logout failed' });
  }
});

// ── POST /projects/import ─────────────────────────────────────────────
router.post('/projects/import', requireAuth, async (req, res) => {
  const { repo_url, name } = req.body;
  if (!repo_url) {
    return res.status(400).json({ error: 'repo_url required' });
  }

  const userId = req.user.id;
  const projectName = name || repo_url.split('/').pop().replace('.git', '');
  const dataDir = process.env.DATA_DIR || '/data/users';
  const projectDir = `${dataDir}/${userId}/Projects/${projectName}`;

  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);

    await exec('mkdir', ['-p', `${dataDir}/${userId}/Projects`]);
    await exec('git', ['clone', '--depth', '1', repo_url, projectDir], { timeout: 60000 });

    res.status(201).json({
      project: projectName,
      path: projectDir,
      url: `/u/${userId}/?project=${encodeURIComponent(projectName)}`,
    });
  } catch (err) {
    console.error('[import] Clone error:', err.message);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

// ── User editor reverse proxy ─────────────────────────────────────────
// All /u/:userId/* requests are proxied to the user's editor container.
// The /u/:userId prefix is stripped so the editor sees clean paths.
router.use('/u/:userId', requireAuth, async (req, res) => {
  const { userId } = req.params;

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

  // Proxy to editor container, stripping /u/{userId} prefix
  // req.url = everything after /u/:userId (e.g. "/" or "/api/project/detect")
  const targetUrl = `http://localhost:${editor.editorPort}${req.url}`;

  try {
    const headers = { ...req.headers };
    delete headers.host; // Don't forward the host header
    headers['x-forwarded-for'] = req.ip;
    headers['x-forwarded-proto'] = req.protocol;

    const proxyRes = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
      redirect: 'manual',
    });

    // Forward status and headers
    res.status(proxyRes.status);
    proxyRes.headers.forEach((value, key) => {
      if (!['content-encoding', 'transfer-encoding'].includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    // Stream the body
    const body = await proxyRes.arrayBuffer();
    res.send(Buffer.from(body));
  } catch (err) {
    console.error(`[proxy] Error proxying to ${targetUrl}: ${err.message}`);
    res.status(502).send('Editor proxy error');
  }
});

export default router;
