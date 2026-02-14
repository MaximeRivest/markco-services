# Sandbox & Auth — Design Spec

> Status: **approved design, not yet implemented**
> Created: 2026-02-14
> Last context: domain migration to markco.dev complete, systemd renamed to markco.service,
> login/dashboard pages redesigned and deployed, placeholder sandbox deployed (needs replacement).

---

## 1. The Big Idea

markco.dev should have **zero friction to try**. A visitor lands on the site and can be inside the full editor — with file tree, code execution, AI commands — in under 3 seconds, without signing up. The sandbox is **the same app** as the authenticated version, not a stripped-down demo. The only differences are the storage backend and available runtimes.

---

## 2. Three Tiers of Users

| Tier | Storage | Runtimes | Collaboration | AI |
|------|---------|----------|---------------|-----|
| **Guest (sandbox)** | IndexedDB in browser | JS (mrmd-js) + Python (Pyodide/Wasm) | None | User's own API key via proxy |
| **Free (signed in)** | Server filesystem | JS, Python, Bash, R, Julia, PTY | Yjs real-time sync | Server-side mrmd-ai |
| **Paid (future)** | Same + more storage | Same + GPU, bigger instances | Same | Same + included API credits |

---

## 3. Architecture: Same App, Different Shim

The mrmd editor UI is a single `index.html` (~14k lines) that talks to `window.electronAPI`. Three shims exist:

| Context | Shim | Backend |
|---------|------|---------|
| Electron desktop | `preload.cjs` (IPC) | Local Node.js processes |
| Server/cloud (signed in) | `http-shim.js` | HTTP calls to mrmd-server |
| **Sandbox (guest)** | **`browser-shim.js`** (NEW) | IndexedDB + localStorage + Pyodide |

All three implement the identical `window.electronAPI` interface. The editor doesn't know or care which shim is loaded.

### 3.1 How the sandbox is served

```
GET /sandbox
  → serves index.html from mrmd-electron/editor/
  → but with <script src="/static/browser-shim.js"> instead of http-shim.js
  → and no token requirement
  → CSP relaxed to allow Pyodide CDN + AI API endpoints
```

The orchestrator's `/sandbox` route:
1. Reads the same `index.html` the editor containers serve
2. Replaces the shim script tag
3. Injects sandbox-mode config (e.g., `window.MRMD_SANDBOX = true`)
4. Serves it directly (no container needed)

---

## 4. browser-shim.js — Full Spec

Implements `window.electronAPI` backed by browser-local storage.

### 4.1 Virtual Filesystem (IndexedDB)

**Database:** `markco-sandbox-fs`
**Object store:** `files` — keyed by absolute path string

```js
{ path: '/sandbox/docs/hello.md', content: '# Hello\n...', modified: Date, created: Date, isDir: false }
{ path: '/sandbox/docs/', content: null, modified: Date, created: Date, isDir: true }
```

**Default project structure on first visit:**
```
/sandbox/
  mrmd.md          (project config)
  docs/
    01-welcome.md  (initial tutorial document)
```

**API mapping:**

| electronAPI method | browser-shim implementation |
|---|---|
| `file.scan(root, opts)` | Query IndexedDB by path prefix, filter by extension |
| `file.create(path, content)` | Put into IndexedDB |
| `file.read(path)` | Get from IndexedDB |
| `file.write(path, content)` | Put into IndexedDB |
| `file.delete(path)` | Delete from IndexedDB |
| `file.move(root, from, to)` | Delete old + put new in IndexedDB |
| `file.createInProject(root, rel, content)` | Same as create with path join |
| `file.reorder(...)` | Reorder in IndexedDB (FSML ordering) |
| `scanFiles(dir)` | Emit `files-update` event from IndexedDB scan |
| `readPreview(path, lines)` | Read from IndexedDB, slice lines |
| `getFileInfo(path)` | Return metadata from IndexedDB entry |

### 4.2 Project Service

| Method | Implementation |
|---|---|
| `project.get(path)` | Return fixed sandbox project: `{ root: '/sandbox', config: {...}, syncPort: null }` |
| `project.nav(root)` | Build nav tree from IndexedDB directory listing |
| `project.create(path)` | Create dir + mrmd.md in IndexedDB |
| `project.watch(root)` | No-op (no filesystem events in browser) |
| `project.onChanged(cb)` | Store callback, fire it manually after file mutations |

### 4.3 Session/Runtime Stubs

| Service | Implementation |
|---|---|
| `session.*` (Python) | Return Pyodide session info (see §5) |
| `bash.*` | Return `{ error: 'Sign in for Bash' }` or show upgrade prompt |
| `julia.*` | Same stub |
| `r.*` | Same stub |
| `pty.*` | Same stub |
| `notebook.*` | Stub |

### 4.4 Settings (localStorage)

**Storage key:** `markco.sandbox.settings`

All `settings.*` methods read/write a JSON blob in localStorage.
API keys stored here too (encrypted with a simple key derived from... nothing, it's local-only, just base64 is fine for MVP).

### 4.5 System Stubs

| Method | Return |
|---|---|
| `getHomeDir()` | `'/sandbox'` |
| `getRecent()` | `{ files: [], venvs: [] }` (or populate from IndexedDB) |
| `getAi()` | AI config from localStorage settings |
| `system.info()` | `{ platform: 'browser', sandbox: true }` |
| `system.ensureUv()` | No-op |

### 4.6 Events

No WebSocket connection. Instead, a local EventEmitter:
- `files-update` — fired after any file mutation
- `project:changed` — fired after project structure changes
- Other events — no-op

### 4.7 Sync (Yjs)

The WebSocket constructor interception in browser-shim should **not** connect to any server.
Options:
- Skip Yjs sync entirely (local-only editing works fine)
- Or use `y-indexeddb` for local persistence of Yjs docs (nice-to-have, not MVP)

For MVP: the editor opens documents by reading content from IndexedDB, no Yjs sync.

---

## 5. Pyodide Runtime

### 5.1 Architecture

Create `pyodide-runtime.js` — loaded by browser-shim, registers as a runtime.

```js
// Lazy initialization — only loads Pyodide when first Python cell is executed
let pyodidePromise = null;

function ensurePyodide() {
  if (!pyodidePromise) {
    pyodidePromise = loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/'
    });
  }
  return pyodidePromise;
}
```

### 5.2 Runtime Interface

Same interface as mrmd-js runtime wrapper in mrmd-editor/src/index.js:

```js
{
  supports(lang) {
    return ['python', 'py', 'python3'].includes(lang.toLowerCase());
  },

  async executeStreaming(code, language, onChunk, onStdinRequest) {
    const pyodide = await ensurePyodide();
    // Capture stdout/stderr
    pyodide.setStdout({ batched: (text) => onChunk(text, accumulated, false) });
    pyodide.setStderr({ batched: (text) => onChunk(text, accumulated, false) });

    try {
      const result = await pyodide.runPythonAsync(code);
      // Send final chunk
      onChunk('', finalOutput, true);
      return { success: true, stdout, result: String(result) };
    } catch (err) {
      return { success: false, error: { type: err.type, message: err.message } };
    }
  },

  async execute(code, language) {
    // Same but non-streaming
  }
}
```

### 5.3 Package Installation

Users can `import numpy` etc. Pyodide auto-loads packages on import.
For explicit installs: `micropip.install('package')` in a Python cell.

### 5.4 Registration

In browser-shim.js, after the editor initializes:
```js
// The JS runtime auto-registers (built into mrmd-editor)
// Register Pyodide as the Python runtime
editor.registerRuntime('python', pyodideRuntime);
```

### 5.5 Loading UX

When Pyodide is loading (first Python cell execution):
- Show "Loading Python runtime..." in the output block
- Progress events from Pyodide download
- After cached, subsequent loads are <500ms

---

## 6. AI Commands in Sandbox

### 6.1 User Flow

1. User opens Settings panel (same UI as full app)
2. Pastes their Anthropic/OpenAI API key
3. Key stored in localStorage
4. AI commands (Cmd+K, finish sentence, fix grammar, etc.) work

### 6.2 Proxy Endpoint

**New route on orchestrator:** `POST /api/ai/proxy`

```
Request:
  Headers: X-AI-Provider: anthropic|openai
  Body: { messages: [...], model: "...", apiKey: "sk-..." }

Server:
  - Reads apiKey from body (NEVER stored)
  - Forwards request to provider API
  - Streams response back via SSE

Response:
  Content-Type: text/event-stream
  (streamed AI response)
```

Why proxy instead of direct browser calls:
- API key not visible in browser devtools Network tab
- Works uniformly for all providers (no CORS issues)
- We can add rate limiting, abuse detection later
- Single endpoint, clean

### 6.3 browser-shim AI Integration

The `settings.getApiKey(provider)` reads from localStorage.
The AI service in the editor is configured to call `/api/ai/proxy` with the user's key.

---

## 7. Auth Improvements (Separate from Sandbox)

### 7.1 Current State (deployed)

- ✅ GitHub OAuth — working
- ✅ Styled login page with buttons for GitHub, Google, Email
- ✅ Styled dashboard
- ✅ Fixed logout (cookie cleanup, both domain shapes)
- ✅ `/sandbox` route exists (needs replacement with real editor)

### 7.2 Google OAuth (next)

1. Create Google Cloud project → OAuth 2.0 credentials
2. Authorized redirect URI: `https://markco.dev/auth/callback/google`
3. Add env vars to `markco.service`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
4. Backend already implemented in auth-service (`POST /auth/google` with token exchange)
5. Frontend button already wired (`/login/google` route exists)
6. Just needs the Google Cloud project + credentials

### 7.3 Magic Email Link (after Google)

1. Set up AWS SES for `markco.dev` domain (verify via DNS TXT record)
2. New DB table: `magic_links (id, email, token, expires_at, created_at)`
3. `POST /auth/email` → generates token, sends email via SES
4. `GET /auth/verify?token=...` → validates, creates/finds user, creates session, redirects to dashboard
5. Wire up the "Continue with Email Link" button on login page

---

## 8. Implementation Order

### Phase 1: browser-shim.js + sandbox serving (core)
**Files to create:**
- `markco-services/orchestrator/static/browser-shim.js` — full electronAPI shim backed by IndexedDB
- Update `markco-services/orchestrator/src/routes/main.js` — `/sandbox` serves real index.html with browser-shim

**Files to modify:**
- Caddy config to serve `browser-shim.js` from `/static/`
- Copy `mrmd-electron/index.html` to static serving path (or read + inject at serve time)

**Test:** Visit `/sandbox`, see full editor UI with file tree, create/rename files, edit markdown.

### Phase 2: Pyodide runtime
**Files to create:**
- `markco-services/orchestrator/static/pyodide-runtime.js` — Pyodide wrapper with MRP runtime interface

**Test:** Write a Python cell in sandbox, hit Shift+Enter, see output. `import numpy` works.

### Phase 3: AI proxy
**Files to create:**
- `markco-services/orchestrator/src/routes/ai-proxy.js` — streaming proxy endpoint
- Update browser-shim.js AI methods to use proxy

**Test:** Paste API key in settings, use Cmd+K or AI commands, get streaming responses.

### Phase 4: Google OAuth
- Create Google Cloud project + OAuth app
- Add env vars to markco.service
- Test login flow end-to-end

### Phase 5: Magic Email Link
- Set up AWS SES
- Implement magic link endpoints
- Wire up login page button

---

## 9. What's Already Done (as of 2026-02-14)

### Infrastructure
- ✅ Domain: `markco.dev` purchased (GoDaddy)
- ✅ DNS: A record → `52.60.156.234` (Elastic IP, permanent)
- ✅ HTTPS: Let's Encrypt cert via Caddy (auto-renewing, expires May 15 2026)
- ✅ Systemd: `markco.service` (was `feuille.service`)

### Branding
- ✅ All code references: `feuille.dev` → `markco.dev`
- ✅ All package names: `@feuille/*` → `@markco/*`
- ✅ GitHub OAuth app: updated to markco.dev URLs
- ✅ Old `feuille-services/` folder removed, canonical repo is `markco-services/`

### Auth & UI
- ✅ Login page: styled, GitHub button works, Google/Email buttons shown as "soon"
- ✅ Dashboard: styled, no more leaked port numbers
- ✅ Logout: works (cookie cleanup handles both domain shapes)
- ✅ Google OAuth backend: token exchange implemented in auth-service (needs credentials)

### Server
- ✅ `markco.service` running on `52.60.156.234`
- ✅ `mrmd.iife.js` available at `/static/mrmd.iife.js` (6.5MB, served by Caddy)
- ✅ Caddy JSON config includes static file serving route
- ✅ `/sandbox` route exists (currently serves placeholder, needs Phase 1 replacement)

---

## 10. Key File Locations

### Local development
```
markco-services/
  orchestrator/
    src/routes/main.js        ← login, dashboard, sandbox, logout, proxy routes
    src/service-client.js     ← HTTP clients for auth/compute/publish/monitor
    src/caddy-config.js       ← Caddy JSON config generator
    src/index.js              ← Express app, WebSocket proxy
    static/sandbox.html       ← current placeholder (TO BE REPLACED)
    static/browser-shim.js    ← TO BE CREATED
    static/pyodide-runtime.js ← TO BE CREATED
    Caddyfile                 ← static Caddyfile (boot fallback)
  auth-service/
    src/routes/auth.js        ← GitHub + Google OAuth, logout, validate
    src/schema.sql            ← users, sessions, invites tables
  docs/
    SANDBOX-AND-AUTH-SPEC.md  ← THIS FILE

mrmd-electron/
  index.html                  ← the full editor UI (14k lines)
  editor/
    mrmd.iife.js              ← bundled editor + mrmd-js runtime

mrmd-server/
  static/http-shim.js        ← reference for browser-shim.js API surface
```

### On server (52.60.156.234)
```
/etc/systemd/system/markco.service
/opt/feuille/feuille-services/orchestrator/   ← deployed orchestrator code
/opt/feuille/feuille-services/auth-service/   ← deployed auth code
/opt/feuille/static/static/mrmd.iife.js       ← editor JS bundle
/opt/feuille/static/static/mrmd-reader.iife.js
/opt/feuille/editor-build/mrmd-electron/      ← editor container build context
```

> Note: Server paths still use `/opt/feuille/` — renaming server paths is low priority
> and would require updating systemd WorkingDirectory, Dockerfiles, and deploy scripts.
> The important thing is the user-facing domain is markco.dev.
