/**
 * browser-shim.js — Drop-in replacement for Electron's electronAPI
 *
 * This shim allows the full mrmd editor UI (index.html) to work as a
 * standalone browser sandbox. All file operations are backed by IndexedDB,
 * settings by localStorage, and runtimes are stubbed (JS is built-in to
 * the editor; Python is handled by Pyodide via sandbox-bridge.js).
 *
 * Loaded BEFORE mrmd.iife.js so window.electronAPI is available when
 * the main app script initializes.
 */

(function () {
  'use strict';

  // ========================================================================
  // Configuration
  // ========================================================================

  window.MRMD_SANDBOX = true;

  const SANDBOX_ROOT = '/sandbox';
  const DB_NAME = 'markco-sandbox-fs';
  const DB_VERSION = 1;
  const STORE_NAME = 'files';
  const SETTINGS_KEY = 'markco.sandbox.settings';
  const RECENT_KEY = 'markco.sandbox.recent';
  const SEED_VERSION_KEY = 'markco.sandbox.seed-version';
  const CURRENT_SEED_VERSION = 3; // Bump when DEFAULT_WELCOME_DOC changes

  const DEFAULT_SANDBOX_SETTINGS = {
    version: 1,
    apiKeys: {
      anthropic: '',
      openai: '',
      groq: '',
      gemini: '',
      openrouter: '',
    },
    qualityLevels: {
      1: { model: 'groq/moonshotai/kimi-k2-instruct-0905', reasoningDefault: 0, name: 'Quick' },
      2: { model: 'anthropic/claude-sonnet-4-5', reasoningDefault: 1, name: 'Balanced' },
      3: { model: 'gemini/gemini-3-pro-preview', reasoningDefault: 2, name: 'Deep' },
      4: { model: 'anthropic/claude-opus-4-5', reasoningDefault: 3, name: 'Maximum' },
      5: {
        type: 'multi',
        models: [
          'openrouter/x-ai/grok-4',
          'openai/gpt-5.2',
          'gemini/gemini-3-pro-preview',
          'anthropic/claude-opus-4-5',
        ],
        synthesizer: 'gemini/gemini-3-pro-preview',
        name: 'Ultimate',
      },
    },
    customSections: [],
    defaults: {
      juiceLevel: 2,
      reasoningLevel: 1,
    },
  };

  const API_PROVIDERS = {
    anthropic: {
      name: 'Anthropic',
      keyPrefix: 'sk-ant-',
      envVar: 'ANTHROPIC_API_KEY',
      testEndpoint: '/api/ai/key-test/anthropic',
    },
    openai: {
      name: 'OpenAI',
      keyPrefix: 'sk-',
      envVar: 'OPENAI_API_KEY',
      testEndpoint: '/api/ai/key-test/openai',
    },
    groq: {
      name: 'Groq',
      keyPrefix: 'gsk_',
      envVar: 'GROQ_API_KEY',
      testEndpoint: '/api/ai/key-test/groq',
    },
    gemini: {
      name: 'Google Gemini',
      keyPrefix: '',
      envVar: 'GEMINI_API_KEY',
      testEndpoint: '/api/ai/key-test/gemini',
    },
    openrouter: {
      name: 'OpenRouter',
      keyPrefix: 'sk-or-',
      envVar: 'OPENROUTER_API_KEY',
      testEndpoint: '/api/ai/key-test/openrouter',
    },
  };

  // ========================================================================
  // IndexedDB Virtual Filesystem
  // ========================================================================

  let dbPromise = null;

  function getDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'path' });
            store.createIndex('parent', 'parent', { unique: false });
            store.createIndex('isDir', 'isDir', { unique: false });
          }
        };

        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
      });
    }
    return dbPromise;
  }

  /** Run a read transaction */
  async function dbRead(fn) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      fn(store, resolve, reject);
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Run a write transaction */
  async function dbWrite(fn) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      fn(store, resolve, reject);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** Get a single file entry */
  async function fsGet(path) {
    return dbRead((store, resolve) => {
      const req = store.get(normalizePath(path));
      req.onsuccess = () => resolve(req.result || null);
    });
  }

  /** Put a file entry */
  async function fsPut(entry) {
    return dbWrite((store) => {
      store.put(entry);
    });
  }

  /** Delete a file entry */
  async function fsDelete(path) {
    return dbWrite((store) => {
      store.delete(normalizePath(path));
    });
  }

  /** Get all entries matching a path prefix */
  async function fsListPrefix(prefix) {
    prefix = normalizePath(prefix);
    return dbRead((store, resolve) => {
      const results = [];
      const range = IDBKeyRange.bound(prefix, prefix + '\uffff', false, false);
      const req = store.openCursor(range);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
    });
  }

  /** Get all entries */
  async function fsAll() {
    return dbRead((store, resolve) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
    });
  }

  function normalizePath(p) {
    // Collapse double slashes, ensure no trailing slash for files
    return p.replace(/\/+/g, '/');
  }

  function parentDir(p) {
    const parts = p.split('/');
    parts.pop();
    return parts.join('/') || '/';
  }

  function baseName(p) {
    return p.split('/').pop() || '';
  }

  /** Ensure all parent directories exist for a given path */
  async function ensureParentDirs(filePath) {
    const parts = filePath.split('/').filter(Boolean);
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current += '/' + parts[i];
      const existing = await fsGet(current);
      if (!existing) {
        const now = Date.now();
        await fsPut({
          path: current,
          parent: parentDir(current),
          content: null,
          isDir: true,
          created: now,
          modified: now,
        });
      }
    }
  }

  // ========================================================================
  // Default Project Seeding
  // ========================================================================

  const DEFAULT_PROJECT_CONFIG = `# sandbox

Project configuration for mrmd.

\`\`\`yaml config
name: "sandbox"

session:
  python:
    venv: .venv
    cwd: .
    name: default
    auto_start: false
  bash:
    cwd: .
    name: default
    auto_start: false

assets:
  directory: _assets
\`\`\`
`;

  const DEFAULT_WELCOME_DOC = `# Welcome to MarkCo Sandbox

This is a live notebook running entirely in your browser.
No account needed — your files are saved in this browser's storage.

## Try JavaScript

\`\`\`javascript
const greeting = "Hello from the sandbox!";
const now = new Date().toLocaleString();
console.log(greeting);
console.log("Current time:", now);
({ greeting, now })
\`\`\`

## Try Python

Python runs via Pyodide (WebAssembly). First run downloads the runtime (~10MB, cached after).

\`\`\`python
import sys
print(f"Python {sys.version}")
print("Running entirely in your browser via WebAssembly!")

data = [1, 2, 3, 4, 5]
mean = sum(data) / len(data)
print(f"Mean of {data} = {mean}")
\`\`\`

numpy, pandas, matplotlib, and many other packages auto-install on import:

\`\`\`python
import numpy as np
x = np.linspace(0, 2 * np.pi, 100)
print(f"Generated {len(x)} points from 0 to 2π")
print(f"sin(π/2) = {np.sin(np.pi/2):.4f}")
\`\`\`

## Try R

R runs via WebR (WebAssembly). First run downloads the runtime (~20MB, cached after).

\`\`\`r
cat("Hello from R!\\n")
x <- 1:10
cat("Mean of 1:10 =", mean(x), "\\n")
cat("SD of 1:10 =", round(sd(x), 4), "\\n")
summary(x)
\`\`\`

## Try HTML

\`\`\`html
<div style="padding: 16px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 8px; color: white; font-family: system-ui;">
  <h3 style="margin: 0 0 8px 0;">✨ Live HTML</h3>
  <p style="margin: 0; opacity: 0.9;">This renders right in the output block.</p>
</div>
\`\`\`

## Paste an image (Ctrl/Cmd+V)

1. Click in this file where you want the image
2. Paste a screenshot or copied image
3. The sandbox saves it into \`_assets/\` and inserts markdown automatically

Try adding one below this line 👇

## Generate a plot image in Python (matplotlib)

\`\`\`python
import numpy as np
import matplotlib.pyplot as plt

x = np.linspace(0, 2 * np.pi, 240)
y = np.sin(x)

plt.figure(figsize=(6, 3.2))
plt.plot(x, y, linewidth=2)
plt.title("Sandbox matplotlib demo")
plt.xlabel("x")
plt.ylabel("sin(x)")
plt.grid(alpha=0.25)
plt.tight_layout()
plt.show()
\`\`\`

If this renders an image output, sandbox asset handling is working ✅

## What works here

- **JavaScript** and **HTML** — instant, runs in browser
- **Python** — via Pyodide (WebAssembly), with numpy/pandas/matplotlib
- **R** — via WebR (WebAssembly), with base R packages
- **AI commands** — bring your own API keys/models in Settings (LiteLLM model names)
- **Files & folders** — saved in IndexedDB (this browser only)
- **Themes** — use the theme picker in the bottom bar
- **Navigation** — Cmd/Ctrl+P to open files, sidebar for project tree

## Want more?

[Sign in](/) for Bash, Julia, terminal access,
collaboration, and cloud persistence.
`;

  async function seedDefaultProject() {
    const root = await fsGet(SANDBOX_ROOT);
    const lastSeedVersion = parseInt(localStorage.getItem(SEED_VERSION_KEY) || '0', 10);

    if (root && lastSeedVersion >= CURRENT_SEED_VERSION) {
      // Already seeded at current version — but ensure welcome.md exists
      const welcome = await fsGet(SANDBOX_ROOT + '/welcome.md');
      if (!welcome) {
        const now = Date.now();
        await fsPut({
          path: SANDBOX_ROOT + '/welcome.md',
          parent: SANDBOX_ROOT,
          content: DEFAULT_WELCOME_DOC,
          isDir: false,
          created: now,
          modified: now,
        });
        console.log('[browser-shim] Re-seeded welcome.md');
      }
      return;
    }

    if (root && lastSeedVersion < CURRENT_SEED_VERSION) {
      // Seed version changed — update welcome.md with new content
      const now = Date.now();
      await fsPut({
        path: SANDBOX_ROOT + '/welcome.md',
        parent: SANDBOX_ROOT,
        content: DEFAULT_WELCOME_DOC,
        isDir: false,
        created: now,
        modified: now,
      });
      localStorage.setItem(SEED_VERSION_KEY, String(CURRENT_SEED_VERSION));
      console.log('[browser-shim] Updated welcome.md to seed version', CURRENT_SEED_VERSION);
      return;
    }

    const now = Date.now();
    const entries = [
      { path: SANDBOX_ROOT, parent: '/', content: null, isDir: true, created: now, modified: now },
      { path: SANDBOX_ROOT + '/_assets', parent: SANDBOX_ROOT, content: null, isDir: true, created: now, modified: now },
      { path: SANDBOX_ROOT + '/mrmd.md', parent: SANDBOX_ROOT, content: DEFAULT_PROJECT_CONFIG, isDir: false, created: now, modified: now },
      { path: SANDBOX_ROOT + '/welcome.md', parent: SANDBOX_ROOT, content: DEFAULT_WELCOME_DOC, isDir: false, created: now, modified: now },
    ];

    for (const entry of entries) {
      await fsPut(entry);
    }

    localStorage.setItem(SEED_VERSION_KEY, String(CURRENT_SEED_VERSION));
    console.log('[browser-shim] Seeded default sandbox project (v' + CURRENT_SEED_VERSION + ')');
  }

  // ========================================================================
  // Event System (local emitter — no WebSocket)
  // ========================================================================

  const eventHandlers = {
    'files-update': [],
    'venv-found': [],
    'venv-scan-done': [],
    'project:changed': [],
    'sync-server-died': [],
  };

  function emit(event, data) {
    const handlers = eventHandlers[event];
    if (!handlers) return;
    handlers.forEach(cb => {
      try { cb(data); } catch (err) {
        console.error('[browser-shim] Event handler error:', err);
      }
    });
  }

  let fileScanToken = 0;

  // ========================================================================
  // WebSocket Interceptor (no-op for sandbox)
  // ========================================================================

  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    // Intercept sync server connections — return a mock that never connects
    const match = url.match(/^wss?:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) {
      console.log('[browser-shim] Intercepting sync WebSocket (no-op):', url);
      // Return a mock WebSocket that fires close immediately
      const mock = {
        readyState: 3, // CLOSED
        url,
        send() {},
        close() {},
        addEventListener(ev, fn) {
          if (ev === 'close') setTimeout(() => fn({ code: 1000, reason: 'sandbox' }), 0);
        },
        removeEventListener() {},
        onopen: null,
        onclose: null,
        onmessage: null,
        onerror: null,
      };
      return mock;
    }
    return new OriginalWebSocket(url, protocols);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;

  // ========================================================================
  // Fetch Interceptor (no-op for sandbox)
  // ========================================================================

  const OriginalFetch = window.fetch;

  function isAiLocalPath(pathname) {
    if (!pathname) return false;
    if (pathname === '/programs' || pathname === '/juice' || pathname === '/reasoning') return true;
    if (pathname === '/api/custom-programs/register' || pathname === '/api/custom-programs') return true;
    if (/^\/(?:[A-Za-z][A-Za-z0-9_]*Predict|Custom_[A-Za-z0-9_]+)(?:\/stream)?$/.test(pathname)) return true;
    return false;
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const match = url && url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)(\/[^?#]*)?(\?[^#]*)?/);

    if (match) {
      const pathname = match[2] || '/';
      const search = match[3] || '';

      // AI traffic is transparently proxied through orchestrator.
      if (isAiLocalPath(pathname)) {
        const proxied = `/api/ai/proxy${pathname}${search}`;
        const aiInit = { ...(init || {}) };
        const headers = new Headers(aiInit.headers || {});

        // Always forward locally stored API keys so sandbox users can use
        // any configured LiteLLM provider without server-side persistence.
        const apiKeys = getSetting('apiKeys', {});
        for (const [provider, key] of Object.entries(apiKeys)) {
          if (!key) continue;
          headers.set(`X-Api-Key-${provider}`, key);
        }

        aiInit.headers = headers;
        return OriginalFetch.call(window, proxied, aiInit);
      }

      // All other localhost services are unavailable in sandbox mode.
      console.warn('[browser-shim] Blocked fetch to local service (sandbox):', url);
      return Promise.resolve(new Response(JSON.stringify({ error: 'Not available in sandbox' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }));
    }

    return OriginalFetch.call(window, input, init);
  };

  // ========================================================================
  // Settings (localStorage)
  // ========================================================================

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function mergeSettingsWithDefaults(loaded) {
    const merged = clone(DEFAULT_SANDBOX_SETTINGS);
    const source = loaded && typeof loaded === 'object' ? loaded : {};

    for (const key of Object.keys(DEFAULT_SANDBOX_SETTINGS)) {
      if (source[key] === undefined) continue;

      if (
        typeof DEFAULT_SANDBOX_SETTINGS[key] === 'object'
        && DEFAULT_SANDBOX_SETTINGS[key] !== null
        && !Array.isArray(DEFAULT_SANDBOX_SETTINGS[key])
      ) {
        merged[key] = { ...DEFAULT_SANDBOX_SETTINGS[key], ...(source[key] || {}) };
      } else {
        merged[key] = source[key];
      }
    }

    return merged;
  }

  function getAllSettings() {
    try {
      const loaded = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      const merged = mergeSettingsWithDefaults(loaded);
      return merged;
    } catch {
      return clone(DEFAULT_SANDBOX_SETTINGS);
    }
  }

  function saveAllSettings(settings) {
    const merged = mergeSettingsWithDefaults(settings);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  }

  function getSetting(key, defaultValue) {
    const settings = getAllSettings();
    const parts = key.split('.');
    let current = settings;
    for (const part of parts) {
      if (current == null || typeof current !== 'object') return defaultValue;
      current = current[part];
    }
    return current !== undefined ? current : defaultValue;
  }

  function setSetting(key, value) {
    const settings = getAllSettings();
    const parts = key.split('.');
    let current = settings;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
    saveAllSettings(settings);
  }

  function createId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  }

  // ========================================================================
  // Asset Blob URL Cache (for rendering images from IndexedDB)
  // ========================================================================

  /** Map<absolutePath, blobURL> */
  const assetBlobCache = new Map();

  /**
   * Convert base64 string to a blob URL for browser display.
   */
  function base64ToBlobUrl(base64, mimeType) {
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' });
      return URL.createObjectURL(blob);
    } catch (e) {
      console.warn('[asset-cache] Failed to create blob URL:', e);
      return null;
    }
  }

  /**
   * Convert Uint8Array -> base64 without blowing the JS call stack
   * on large images (mobile camera photos, screenshots, etc.).
   */
  async function uint8ArrayToBase64(bytes) {
    // Preferred path: FileReader on a Blob (stream-safe for large payloads)
    if (typeof FileReader !== 'undefined') {
      try {
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(reader.error || new Error('FileReader failed'));
          reader.readAsDataURL(blob);
        });
        const comma = dataUrl.indexOf(',');
        return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      } catch {
        // Fall through to chunked encoder
      }
    }

    // Fallback path: chunked String.fromCharCode to avoid "Maximum call stack size exceeded"
    const chunkSize = 0x8000; // 32KB chunks
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  /**
   * Guess MIME type from filename.
   */
  function mimeFromFilename(name) {
    const ext = (name || '').split('.').pop().toLowerCase();
    const map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf',
    };
    return map[ext] || 'application/octet-stream';
  }

  /**
   * Cache a single asset's blob URL from its IndexedDB entry.
   */
  function cacheAssetBlob(entry) {
    if (!entry || !entry.content || entry.isDir) return null;
    const existing = assetBlobCache.get(entry.path);
    if (existing) return existing;
    const blobUrl = base64ToBlobUrl(entry.content, mimeFromFilename(entry.path));
    if (blobUrl) assetBlobCache.set(entry.path, blobUrl);
    return blobUrl;
  }

  /**
   * Preload all assets in a project into the blob URL cache.
   * Call this when opening a document or switching projects.
   */
  async function preloadProjectAssets(projectRoot) {
    projectRoot = projectRoot || SANDBOX_ROOT;
    const assetsDir = projectRoot + '/_assets';
    try {
      const entries = await fsListPrefix(assetsDir + '/');
      let count = 0;
      for (const entry of entries) {
        if (!entry.isDir && entry.content) {
          cacheAssetBlob(entry);
          count++;
        }
      }
      if (count > 0) console.log(`[asset-cache] Preloaded ${count} assets from ${assetsDir}`);
    } catch (e) {
      // No assets dir yet — that's fine
    }
  }

  /**
   * Resolve an absolute asset path to a blob URL (synchronous lookup).
   * Returns null if not cached.
   */
  function resolveAssetBlobUrl(absolutePath) {
    return assetBlobCache.get(absolutePath) || null;
  }

  // Expose for sandbox-bridge and inline scripts
  window._sandboxAssetCache = {
    preload: preloadProjectAssets,
    resolve: resolveAssetBlobUrl,
    cache: assetBlobCache,
  };

  // ========================================================================
  // Recent Files (localStorage)
  // ========================================================================

  function getRecentFiles() {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY)) || [];
    } catch {
      return [];
    }
  }

  function addRecentFile(filePath) {
    let recent = getRecentFiles();
    recent = recent.filter(f => f !== filePath);
    recent.unshift(filePath);
    if (recent.length > 50) recent = recent.slice(0, 50);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
  }

  // ========================================================================
  // FSML Utilities (ported from mrmd-project/src/fsml.js)
  // ========================================================================

  /**
   * Title from filename: remove extension, numeric prefix, replace separators.
   * Matches mrmd-project/src/fsml.js titleFromFilename().
   */
  function titleFromFilename(filename) {
    if (!filename) return '';
    let name = filename.replace(/\.[^.]+$/, '');       // remove extension
    name = name.replace(/^\d+-/, '');                    // remove numeric prefix (01-)
    name = name.replace(/[-_]/g, ' ');                   // replace hyphens/underscores
    name = name.split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    return name;
  }

  function isIndexFile(filename) {
    const lower = filename.toLowerCase();
    return lower === 'index.md' || lower === 'readme.md' || lower === 'index.qmd';
  }

  /**
   * Parse a relative path into FSML components.
   * Matches mrmd-project/src/fsml.js parsePath().
   */
  function fsmlParsePath(relativePath) {
    if (!relativePath) {
      return { path: '', order: null, name: '', extension: '', isFolder: false, parent: '' };
    }
    const p = relativePath.replace(/\/+$/, '');
    const segments = p.split('/').filter(Boolean);
    const parentPath = segments.slice(0, -1).join('/');
    const filename = segments[segments.length - 1] || '';
    const hasExtension = /\.[^./]+$/.test(filename);
    const isFolder = !hasExtension;
    const extMatch = filename.match(/(\.[^.]+)$/);
    const extension = extMatch ? extMatch[1] : '';
    const nameWithoutExt = filename.replace(/\.[^.]+$/, '');
    const prefixMatch = nameWithoutExt.match(/^(\d+)[-_]/);
    const order = prefixMatch ? parseInt(prefixMatch[1], 10) : null;
    const name = prefixMatch ? nameWithoutExt.replace(/^\d+[-_]/, '') : nameWithoutExt;
    return { path: p, order, name, extension, isFolder, parent: parentPath };
  }

  /**
   * Compute renames needed for a reorder operation.
   * Matches mrmd-project/src/fsml.js computeReorder().
   */
  function computeReorder(sourcePath, targetPath, position, allFiles) {
    const source = fsmlParsePath(sourcePath);
    const target = fsmlParsePath(targetPath);

    let targetDir = '';
    if (position === 'inside') {
      targetDir = targetPath;
    } else {
      targetDir = target.parent;
    }

    // Siblings in target directory with numeric order
    const siblingsInDir = allFiles
      .filter(p => fsmlParsePath(p).parent === targetDir)
      .map(p => ({ path: p, ...fsmlParsePath(p) }))
      .filter(s => s.order !== null)
      .sort((a, b) => a.order - b.order);

    // Determine insert order
    let insertOrder;
    if (position === 'inside') {
      const maxOrder = siblingsInDir.reduce((max, s) => Math.max(max, s.order || 0), 0);
      insertOrder = maxOrder + 1;
    } else if (position === 'before') {
      insertOrder = target.order || 1;
    } else {
      insertOrder = (target.order || 0) + 1;
    }

    const paddedOrder = String(insertOrder).padStart(2, '0');
    const sourceExt = source.isFolder ? '' : source.extension;
    const newFilename = `${paddedOrder}-${source.name}${sourceExt}`;
    const newPath = targetDir ? `${targetDir}/${newFilename}` : newFilename;

    const renames = [];
    const sourceInSameDir = source.parent === targetDir;

    if (sourceInSameDir && source.order !== null) {
      const sourceOrder = source.order;

      if (sourceOrder < insertOrder) {
        // Moving DOWN
        const adjustedInsertOrder = insertOrder - 1;
        for (const sibling of siblingsInDir) {
          if (sibling.path === sourcePath) continue;
          if (sibling.order > sourceOrder && sibling.order <= adjustedInsertOrder) {
            const newO = String(sibling.order - 1).padStart(2, '0');
            const sExt = sibling.isFolder ? '' : sibling.extension;
            const np = targetDir ? `${targetDir}/${newO}-${sibling.name}${sExt}` : `${newO}-${sibling.name}${sExt}`;
            if (sibling.path !== np) renames.push({ from: sibling.path, to: np });
          }
        }
        const finalO = String(adjustedInsertOrder).padStart(2, '0');
        const finalPath = targetDir ? `${targetDir}/${finalO}-${source.name}${sourceExt}` : `${finalO}-${source.name}${sourceExt}`;
        if (sourcePath !== finalPath) renames.push({ from: sourcePath, to: finalPath });
        return { newPath: finalPath, renames: sortRenames(renames, 'down') };

      } else if (sourceOrder > insertOrder) {
        // Moving UP
        for (const sibling of siblingsInDir) {
          if (sibling.path === sourcePath) continue;
          if (sibling.order >= insertOrder && sibling.order < sourceOrder) {
            const newO = String(sibling.order + 1).padStart(2, '0');
            const sExt = sibling.isFolder ? '' : sibling.extension;
            const np = targetDir ? `${targetDir}/${newO}-${sibling.name}${sExt}` : `${newO}-${sibling.name}${sExt}`;
            if (sibling.path !== np) renames.push({ from: sibling.path, to: np });
          }
        }
        if (sourcePath !== newPath) renames.push({ from: sourcePath, to: newPath });
        return { newPath, renames: sortRenames(renames, 'up') };

      } else {
        return { newPath: sourcePath, renames: [] };
      }
    } else {
      // Cross-directory move
      for (const sibling of siblingsInDir) {
        if (sibling.order >= insertOrder) {
          const newO = String(sibling.order + 1).padStart(2, '0');
          const sExt = sibling.isFolder ? '' : sibling.extension;
          const np = targetDir ? `${targetDir}/${newO}-${sibling.name}${sExt}` : `${newO}-${sibling.name}${sExt}`;
          if (sibling.path !== np) renames.push({ from: sibling.path, to: np });
        }
      }
      if (sourcePath !== newPath) renames.push({ from: sourcePath, to: newPath });
      return { newPath, renames: sortRenames(renames, 'up') };
    }
  }

  function sortRenames(renames, direction) {
    return renames.sort((a, b) => {
      const aO = fsmlParsePath(a.from).order || 0;
      const bO = fsmlParsePath(b.from).order || 0;
      return direction === 'up' ? bO - aO : aO - bO;
    });
  }

  /**
   * Build a nav tree from IndexedDB entries matching a project root.
   * Returns the same shape as mrmd-project FSML.buildNavTree():
   *   [{ path, title, order, isFolder, hasIndex, children }]
   */
  async function buildNavTree(projectRoot) {
    const entries = await fsListPrefix(projectRoot + '/');
    const mdFiles = entries
      .filter(e => !e.isDir && (e.path.toLowerCase().endsWith('.md') || e.path.toLowerCase().endsWith('.qmd')))
      .map(e => e.path.slice(projectRoot.length + 1)) // relative paths
      .filter(rel => {
        // Skip hidden dirs/files and mrmd.md
        if (rel === 'mrmd.md') return false;
        return !rel.split('/').some(part => part.startsWith('.') || part.startsWith('_'));
      })
      .sort();

    // Build folder map
    const folders = new Map();
    const rootChildren = [];

    // First pass: identify folders, mark hasIndex
    for (const relPath of mdFiles) {
      const segments = relPath.split('/');

      for (let i = 0; i < segments.length - 1; i++) {
        const folderPath = segments.slice(0, i + 1).join('/');
        if (!folders.has(folderPath)) {
          const folderName = segments[i];
          const orderMatch = folderName.match(/^(\d+)-/);
          folders.set(folderPath, {
            path: folderPath,
            title: titleFromFilename(folderName),
            order: orderMatch ? parseInt(orderMatch[1], 10) : null,
            isFolder: true,
            hasIndex: false,
            children: [],
          });
        }
      }

      // Check if this is an index file
      const filename = segments[segments.length - 1];
      if (isIndexFile(filename) && segments.length > 1) {
        const parentPath = segments.slice(0, -1).join('/');
        if (folders.has(parentPath)) {
          folders.get(parentPath).hasIndex = true;
        }
      }
    }

    // Second pass: build file nodes
    for (const relPath of mdFiles) {
      const segments = relPath.split('/');
      const filename = segments[segments.length - 1];

      // Skip index files (represented by folder itself)
      if (isIndexFile(filename)) continue;

      const orderMatch = filename.match(/^(\d+)-/);
      const node = {
        path: relPath,
        title: titleFromFilename(filename),
        order: orderMatch ? parseInt(orderMatch[1], 10) : null,
        isFolder: false,
        hasIndex: false,
        children: [],
      };

      if (segments.length === 1) {
        rootChildren.push(node);
      } else {
        const parentPath = segments.slice(0, -1).join('/');
        if (folders.has(parentPath)) {
          folders.get(parentPath).children.push(node);
        }
      }
    }

    // Third pass: add folders to tree
    const folderList = Array.from(folders.values());
    folderList.sort((a, b) => a.path.split('/').length - b.path.split('/').length);

    for (const folder of folderList) {
      const segments = folder.path.split('/');
      if (segments.length === 1) {
        rootChildren.push(folder);
      } else {
        const parentPath = segments.slice(0, -1).join('/');
        if (folders.has(parentPath)) {
          folders.get(parentPath).children.push(folder);
        }
      }
    }

    // Sort: by order if present, else alphabetical
    const sortNodes = (arr) => {
      arr.sort((a, b) => {
        if (a.order !== null && b.order !== null) return a.order - b.order;
        if (a.order !== null) return -1;
        if (b.order !== null) return 1;
        return a.title.localeCompare(b.title);
      });
      for (const item of arr) {
        if (item.children?.length > 0) sortNodes(item.children);
      }
    };
    sortNodes(rootChildren);

    return rootChildren;
  }

  // ========================================================================
  // Project Service Helpers
  // ========================================================================

  async function getProjectInfo(filePath) {
    // Find project root by looking for mrmd.md
    let dir = filePath;
    if (!filePath.endsWith('/')) {
      dir = parentDir(filePath);
    }

    // Walk up until we find mrmd.md or hit root
    let root = null;
    let configContent = null;
    let current = dir;
    while (current && current.length > 0) {
      const configPath = current + '/mrmd.md';
      const entry = await fsGet(configPath);
      if (entry && !entry.isDir) {
        root = current;
        configContent = entry.content || '';
        break;
      }
      if (current === '/' || current === '') break;
      current = parentDir(current);
    }

    if (!root) return null;

    // Parse basic config from yaml config block
    let config = { name: baseName(root) };
    const yamlMatch = configContent.match(/```yaml\s+config\n([\s\S]*?)```/);
    if (yamlMatch) {
      const yaml = yamlMatch[1];
      const nameMatch = yaml.match(/name:\s*"?([^"\n]+)"?/);
      if (nameMatch) config.name = nameMatch[1].trim();
    }

    // Build file list
    const entries = await fsListPrefix(root + '/');
    const files = entries
      .filter(e => !e.isDir)
      .map(e => e.path.slice(root.length + 1))
      .filter(f => !f.startsWith('.'));

    const navTree = await buildNavTree(root);

    return {
      root,
      config,
      files,
      navTree,
      syncPort: 0, // Sentinel value — sandbox-bridge intercepts this
    };
  }

  // ========================================================================
  // electronAPI Implementation
  // ========================================================================

  window.electronAPI = {
    // ====================================================================
    // System
    // ====================================================================

    getHomeDir: () => Promise.resolve(SANDBOX_ROOT),

    getRecent: () => Promise.resolve({
      files: getRecentFiles(),
      venvs: [],
    }),

    getAi: () => Promise.resolve({
      success: true,
      // Value is only used to build http://127.0.0.1:${port} in index.html;
      // fetch interceptor rewrites those calls to /api/ai/proxy/*.
      port: 51790,
      running: true,
      managed: false,
      sandbox: true,
      url: '/api/ai/proxy',
    }),

    system: {
      info: () => Promise.resolve({
        platform: 'browser',
        sandbox: true,
        arch: 'wasm',
        version: '0.0.0',
      }),
      ensureUv: () => Promise.resolve({ success: true }),
    },

    // ====================================================================
    // Shell (stubs)
    // ====================================================================

    shell: {
      showItemInFolder: async (fullPath) => {
        console.log('[browser-shim] showItemInFolder:', fullPath);
        return { success: false, path: fullPath };
      },
      openExternal: async (url) => {
        window.open(url, '_blank');
        return { success: true };
      },
      openPath: async (fullPath) => {
        console.log('[browser-shim] openPath:', fullPath);
        return { success: false, path: fullPath };
      },
    },

    // ====================================================================
    // File Scanning
    // ====================================================================

    scanFiles: async (searchDir) => {
      const scanToken = ++fileScanToken;

      emit('files-update', {
        scanToken,
        reset: true,
        done: false,
        totalFiles: 0,
        totalDirs: 0,
      });

      try {
        const root = searchDir || SANDBOX_ROOT;
        const entries = await fsListPrefix(root);

        if (scanToken !== fileScanToken) return; // Stale

        const files = entries.filter(e => !e.isDir).map(e => e.path);
        const dirs = entries.filter(e => e.isDir).map(e => e.path);

        emit('files-update', {
          scanToken,
          filesChunk: files,
          dirsChunk: dirs,
          totalFiles: files.length,
          totalDirs: dirs.length,
          done: true,
        });
      } catch (err) {
        if (scanToken !== fileScanToken) return;
        emit('files-update', { scanToken, error: err.message, done: true });
      }
    },

    onFilesUpdate: (callback) => {
      eventHandlers['files-update'].push(callback);
    },

    // ====================================================================
    // Venv Discovery (stubs)
    // ====================================================================

    discoverVenvs: () => {
      // Immediately fire scan-done with empty results
      setTimeout(() => emit('venv-scan-done', {}), 50);
    },

    onVenvFound: (callback) => {
      eventHandlers['venv-found'].push(callback);
    },

    onVenvScanDone: (callback) => {
      eventHandlers['venv-scan-done'].push(callback);
    },

    // ====================================================================
    // File Info
    // ====================================================================

    readPreview: async (filePath, lines) => {
      const entry = await fsGet(filePath);
      if (!entry || entry.isDir) return '';
      const content = entry.content || '';
      if (!lines) return content;
      return content.split('\n').slice(0, lines).join('\n');
    },

    getFileInfo: async (filePath) => {
      const entry = await fsGet(filePath);
      if (!entry) return { success: false, error: 'File not found' };
      return {
        success: true,
        path: entry.path,
        isDir: entry.isDir,
        size: entry.content ? entry.content.length : 0,
        created: entry.created,
        modified: entry.modified,
      };
    },

    // ====================================================================
    // Python Management (stubs)
    // ====================================================================

    createVenv: () => Promise.resolve({ success: false, error: 'Not available in sandbox' }),
    installMrmdPython: () => Promise.resolve({ success: false, error: 'Not available in sandbox' }),
    startPython: () => Promise.resolve({ success: false, error: 'Python runs via Pyodide in sandbox' }),

    // ====================================================================
    // Runtime Management (stubs)
    // ====================================================================

    listRuntimes: () => Promise.resolve([]),
    killRuntime: () => Promise.resolve({ success: true }),
    attachRuntime: () => Promise.resolve({ success: false, error: 'Not available in sandbox' }),

    // ====================================================================
    // Open File
    // ====================================================================

    openFile: async (filePath) => {
      addRecentFile(filePath);

      const project = await getProjectInfo(filePath);
      const fileName = filePath.split('/').pop();
      const lower = fileName.toLowerCase();
      const docName = lower.endsWith('.md') ? fileName.replace(/\.md$/i, '') : fileName;

      return {
        success: true,
        syncPort: 0, // Sentinel — sandbox-bridge.js intercepts drive creation
        docName,
        projectDir: project?.root || parentDir(filePath),
      };
    },

    // ====================================================================
    // Project Service
    // ====================================================================

    project: {
      get: async (filePath) => {
        return getProjectInfo(filePath);
      },

      create: async (targetPath) => {
        const now = Date.now();
        await ensureParentDirs(targetPath + '/mrmd.md');
        await fsPut({
          path: targetPath,
          parent: parentDir(targetPath),
          content: null,
          isDir: true,
          created: now,
          modified: now,
        });

        const config = `# ${baseName(targetPath)}

Project configuration for mrmd.

\`\`\`yaml config
name: "${baseName(targetPath)}"

session:
  python:
    venv: .venv
    cwd: .
    name: default
    auto_start: false

assets:
  directory: _assets
\`\`\`
`;
        await fsPut({
          path: targetPath + '/mrmd.md',
          parent: targetPath,
          content: config,
          isDir: false,
          created: now,
          modified: now,
        });

        await fsPut({
          path: targetPath + '/_assets',
          parent: targetPath,
          content: null,
          isDir: true,
          created: now,
          modified: now,
        });

        emit('project:changed', { projectRoot: targetPath });

        return getProjectInfo(targetPath + '/mrmd.md');
      },

      nav: async (projectRoot) => {
        return buildNavTree(projectRoot);
      },

      invalidate: async () => ({ success: true }),

      watch: async () => ({ success: true }),

      unwatch: async () => ({ success: true }),

      onChanged: (callback) => {
        eventHandlers['project:changed'] = [callback];
      },
    },

    // ====================================================================
    // Session Service (stubs)
    // ====================================================================

    session: {
      list: () => Promise.resolve([]),
      start: () => Promise.resolve({ success: false, error: 'Not available in sandbox' }),
      stop: () => Promise.resolve({ success: true }),
      restart: () => Promise.resolve({ success: false, error: 'Not available in sandbox' }),
      forDocument: () => Promise.resolve(null),
    },

    // ====================================================================
    // Bash Service (stub)
    // ====================================================================

    bash: {
      list: () => Promise.resolve([]),
      start: () => Promise.resolve({ success: false, error: 'Sign in for Bash runtime' }),
      stop: () => Promise.resolve({ success: true }),
      restart: () => Promise.resolve({ success: false, error: 'Sign in for Bash runtime' }),
      forDocument: () => Promise.resolve(null),
    },

    // ====================================================================
    // Julia Service (stub)
    // ====================================================================

    julia: {
      list: () => Promise.resolve([]),
      start: () => Promise.resolve({ success: false, error: 'Sign in for Julia runtime' }),
      stop: () => Promise.resolve({ success: true }),
      restart: () => Promise.resolve({ success: false, error: 'Sign in for Julia runtime' }),
      forDocument: () => Promise.resolve(null),
      isAvailable: () => Promise.resolve(false),
    },

    // ====================================================================
    // PTY Service (stub)
    // ====================================================================

    pty: {
      list: () => Promise.resolve([]),
      start: () => Promise.resolve({ success: false, error: 'Sign in for terminal access' }),
      stop: () => Promise.resolve({ success: true }),
      restart: () => Promise.resolve({ success: false, error: 'Sign in for terminal access' }),
      forDocument: () => Promise.resolve(null),
    },

    // ====================================================================
    // Notebook Service (stub)
    // ====================================================================

    notebook: {
      convert: () => Promise.resolve({ success: false, error: 'Not available in sandbox' }),
      startSync: () => Promise.resolve({ success: false, error: 'Not available in sandbox' }),
      stopSync: () => Promise.resolve({ success: true }),
    },

    // ====================================================================
    // R Service (stub)
    // ====================================================================

    r: {
      list: () => Promise.resolve([]),
      start: () => Promise.resolve({ success: false, error: 'Sign in for R runtime' }),
      stop: () => Promise.resolve({ success: true }),
      restart: () => Promise.resolve({ success: false, error: 'Sign in for R runtime' }),
      forDocument: () => Promise.resolve(null),
      isAvailable: () => Promise.resolve(false),
    },

    // ====================================================================
    // Settings Service
    // ====================================================================

    settings: {
      getAll: () => Promise.resolve(getAllSettings()),

      get: (key, defaultValue) => Promise.resolve(getSetting(key, defaultValue)),

      set: (key, value) => {
        setSetting(key, value);
        return Promise.resolve(true);
      },

      update: (updates) => {
        const settings = getAllSettings();
        Object.assign(settings, updates);
        saveAllSettings(settings);
        return Promise.resolve(true);
      },

      reset: () => {
        localStorage.removeItem(SETTINGS_KEY);
        return Promise.resolve(true);
      },

      getApiKeys: (masked = true) => {
        const keys = getSetting('apiKeys', {});
        if (masked) {
          const maskedKeys = {};
          for (const [provider, key] of Object.entries(keys)) {
            maskedKeys[provider] = key ? '••••' + key.slice(-4) : '';
          }
          return Promise.resolve(maskedKeys);
        }
        return Promise.resolve(keys);
      },

      setApiKey: (provider, key) => {
        const keys = getSetting('apiKeys', {});
        keys[provider] = key;
        setSetting('apiKeys', keys);
        try {
          window.dispatchEvent(new CustomEvent('mrmd:sandbox-settings-changed', {
            detail: { type: 'api-key', provider },
          }));
        } catch { /* ignore */ }
        return Promise.resolve(true);
      },

      getApiKey: (provider) => {
        const keys = getSetting('apiKeys', {});
        const val = keys[provider] || '';
        console.log(`[browser-shim] getApiKey(${provider}) → len=${val.length} prefix=${val.slice(0, 6)}`);
        return Promise.resolve(val);
      },

      hasApiKey: (provider) => {
        const keys = getSetting('apiKeys', {});
        return Promise.resolve(Boolean(keys[provider]));
      },

      getApiProviders: () => Promise.resolve(API_PROVIDERS),

      getQualityLevels: () => Promise.resolve(getSetting('qualityLevels', DEFAULT_SANDBOX_SETTINGS.qualityLevels)),

      setQualityLevelModel: (level, model) => {
        const qualityLevels = { ...getSetting('qualityLevels', DEFAULT_SANDBOX_SETTINGS.qualityLevels) };
        const current = qualityLevels[level] || {};
        qualityLevels[level] = { ...current, model };
        setSetting('qualityLevels', qualityLevels);
        return Promise.resolve(true);
      },

      getCustomSections: () => Promise.resolve(getSetting('customSections', [])),

      addCustomSection: (name) => {
        const customSections = [...getSetting('customSections', [])];
        const section = { id: createId('section'), name, commands: [] };
        customSections.push(section);
        setSetting('customSections', customSections);
        return Promise.resolve(section);
      },

      removeCustomSection: (sectionId) => {
        const customSections = [...getSetting('customSections', [])]
          .filter(section => section.id !== sectionId);
        setSetting('customSections', customSections);
        return Promise.resolve(true);
      },

      addCustomCommand: (sectionId, commandData) => {
        const customSections = [...getSetting('customSections', [])];
        const section = customSections.find(s => s.id === sectionId);
        if (!section) {
          return Promise.resolve({ success: false, error: 'Section not found' });
        }

        const id = createId('cmd');
        const command = {
          id,
          ...commandData,
          program: commandData.program || `Custom_${id.replace(/-/g, '_')}`,
          resultField: commandData.resultField || 'result',
        };

        section.commands = section.commands || [];
        section.commands.push(command);
        setSetting('customSections', customSections);
        return Promise.resolve(command);
      },

      updateCustomCommand: (sectionId, commandId, updates) => {
        const customSections = [...getSetting('customSections', [])];
        const section = customSections.find(s => s.id === sectionId);
        if (!section) return Promise.resolve(false);

        const idx = (section.commands || []).findIndex(c => c.id === commandId);
        if (idx < 0) return Promise.resolve(false);

        section.commands[idx] = { ...section.commands[idx], ...updates };
        setSetting('customSections', customSections);
        return Promise.resolve(true);
      },

      removeCustomCommand: (sectionId, commandId) => {
        const customSections = [...getSetting('customSections', [])];
        const section = customSections.find(s => s.id === sectionId);
        if (!section) return Promise.resolve(false);

        section.commands = (section.commands || []).filter(c => c.id !== commandId);
        setSetting('customSections', customSections);
        return Promise.resolve(true);
      },

      getAllCustomCommands: () => {
        const sections = getSetting('customSections', []);
        const commands = [];
        for (const section of sections) {
          for (const command of (section.commands || [])) {
            commands.push({
              ...command,
              sectionId: section.id,
              sectionName: section.name,
            });
          }
        }
        return Promise.resolve(commands);
      },

      getDefaults: () => Promise.resolve(getSetting('defaults', DEFAULT_SANDBOX_SETTINGS.defaults)),

      setDefaults: (defaults) => {
        setSetting('defaults', { ...getSetting('defaults', DEFAULT_SANDBOX_SETTINGS.defaults), ...defaults });
        return Promise.resolve(true);
      },
      export: () => Promise.resolve(getAllSettings()),
      import: (json) => {
        try {
          const data = typeof json === 'string' ? JSON.parse(json) : json;
          saveAllSettings(data);
        } catch { /* ignore */ }
        return Promise.resolve(true);
      },
    },

    // ====================================================================
    // File Service
    // ====================================================================

    file: {
      scan: async (root, options = {}) => {
        root = root || SANDBOX_ROOT;
        const entries = await fsListPrefix(root);
        let files = entries.filter(e => !e.isDir).map(e => e.path);

        if (options.extensions) {
          const exts = options.extensions.map(e => e.toLowerCase());
          files = files.filter(f => exts.some(ext => f.toLowerCase().endsWith(ext)));
        }

        if (options.maxDepth) {
          const rootDepth = root.split('/').filter(Boolean).length;
          files = files.filter(f => {
            const depth = f.split('/').filter(Boolean).length - rootDepth;
            return depth <= options.maxDepth;
          });
        }

        // Filter hidden unless requested
        if (!options.includeHidden) {
          files = files.filter(f => {
            const rel = f.slice(root.length);
            return !rel.split('/').some(part => part.startsWith('.') && part !== '.');
          });
        }

        return { files, dirs: entries.filter(e => e.isDir).map(e => e.path) };
      },

      create: async (filePath, content = '') => {
        filePath = normalizePath(filePath);
        await ensureParentDirs(filePath);
        const now = Date.now();
        await fsPut({
          path: filePath,
          parent: parentDir(filePath),
          content,
          isDir: false,
          created: now,
          modified: now,
        });
        emit('project:changed', { projectRoot: SANDBOX_ROOT });
        return { success: true, path: filePath };
      },

      createInProject: async (projectRoot, relativePath, content = '') => {
        const fullPath = normalizePath(projectRoot + '/' + relativePath);
        return window.electronAPI.file.create(fullPath, content);
      },

      read: async (filePath) => {
        const entry = await fsGet(filePath);
        if (!entry || entry.isDir) {
          return { success: false, error: 'File not found' };
        }
        return { success: true, content: entry.content || '' };
      },

      write: async (filePath, content) => {
        filePath = normalizePath(filePath);
        const existing = await fsGet(filePath);
        const now = Date.now();
        await fsPut({
          path: filePath,
          parent: parentDir(filePath),
          content,
          isDir: false,
          created: existing?.created || now,
          modified: now,
        });
        return { success: true };
      },

      delete: async (filePath) => {
        filePath = normalizePath(filePath);

        // If it's a directory, delete all children too
        const entry = await fsGet(filePath);
        if (entry?.isDir) {
          const children = await fsListPrefix(filePath + '/');
          for (const child of children) {
            await fsDelete(child.path);
          }
        }
        await fsDelete(filePath);
        emit('project:changed', { projectRoot: SANDBOX_ROOT });
        return { success: true };
      },

      move: async (projectRoot, fromPath, toPath) => {
        // fromPath and toPath are relative to projectRoot
        const fullFrom = normalizePath(projectRoot + '/' + fromPath);
        const fullTo = normalizePath(projectRoot + '/' + toPath);

        const entry = await fsGet(fullFrom);
        if (!entry) {
          return { success: false, error: 'Source not found', movedFile: toPath, updatedFiles: [] };
        }

        const updatedFiles = [];

        // If directory, move all children
        if (entry.isDir) {
          const children = await fsListPrefix(fullFrom + '/');
          for (const child of children) {
            const newChildPath = fullTo + child.path.slice(fullFrom.length);
            await ensureParentDirs(newChildPath);
            await fsPut({ ...child, path: newChildPath, parent: parentDir(newChildPath) });
            await fsDelete(child.path);
            updatedFiles.push(newChildPath.slice(projectRoot.length + 1));
          }
        }

        await ensureParentDirs(fullTo);
        await fsPut({ ...entry, path: fullTo, parent: parentDir(fullTo), modified: Date.now() });
        await fsDelete(fullFrom);

        updatedFiles.push(toPath);
        emit('project:changed', { projectRoot });
        return { success: true, movedFile: toPath, updatedFiles };
      },

      reorder: async (projectRoot, sourcePath, targetPath, position) => {
        // Get all files for sibling computation
        const entries = await fsListPrefix(projectRoot + '/');
        const allFiles = entries
          .filter(e => !e.isDir)
          .map(e => e.path.slice(projectRoot.length + 1))
          .filter(f => !f.split('/').some(p => p.startsWith('.')));

        // Compute the renames using FSML logic
        const { newPath, renames } = computeReorder(sourcePath, targetPath, position, allFiles);

        if (renames.length === 0) {
          return { success: true, movedFile: sourcePath, updatedFiles: [] };
        }

        console.log('[browser-shim] file.reorder:', sourcePath, '->', newPath, `(${renames.length} renames)`);

        const updatedFiles = [];

        // Execute renames in order (sorted to avoid collisions)
        for (const rename of renames) {
          const fullFrom = normalizePath(projectRoot + '/' + rename.from);
          const fullTo = normalizePath(projectRoot + '/' + rename.to);

          const entry = await fsGet(fullFrom);
          if (!entry) continue; // May have been renamed already in batch

          await ensureParentDirs(fullTo);
          await fsPut({ ...entry, path: fullTo, parent: parentDir(fullTo), modified: Date.now() });
          await fsDelete(fullFrom);

          // If directory, also move children
          if (entry.isDir) {
            const children = await fsListPrefix(fullFrom + '/');
            for (const child of children) {
              const newChildPath = fullTo + child.path.slice(fullFrom.length);
              await ensureParentDirs(newChildPath);
              await fsPut({ ...child, path: newChildPath, parent: parentDir(newChildPath) });
              await fsDelete(child.path);
            }
          }

          updatedFiles.push(rename.to);
        }

        emit('project:changed', { projectRoot });
        return { success: true, movedFile: newPath, updatedFiles };
      },
    },

    // ====================================================================
    // Asset Service
    // ====================================================================

    asset: {
      list: async (projectRoot) => {
        projectRoot = projectRoot || SANDBOX_ROOT;
        const assetsDir = projectRoot + '/_assets';
        const entries = await fsListPrefix(assetsDir + '/');
        return entries.filter(e => !e.isDir).map(e => ({
          // Match mrmd-server shape: path relative to _assets/
          path: e.path.startsWith(assetsDir + '/')
            ? e.path.slice((assetsDir + '/').length)
            : baseName(e.path),
          name: baseName(e.path),
          size: e.content ? e.content.length : 0,
          modified: e.modified,
        }));
      },

      save: async (projectRoot, fileData, filename) => {
        projectRoot = projectRoot || SANDBOX_ROOT;
        const assetsDir = projectRoot + '/_assets';
        const relativeAssetPath = String(filename || 'asset.bin').replace(/^\/+/, '');
        const fullAssetPath = normalizePath(assetsDir + '/' + relativeAssetPath);
        await ensureParentDirs(fullAssetPath);

        // fileData may be base64 string or Uint8Array
        let content;
        if (typeof fileData === 'string') {
          content = fileData; // Store base64 as-is
        } else if (fileData instanceof Uint8Array) {
          // Convert to base64 safely (handles large images on mobile)
          content = await uint8ArrayToBase64(fileData);
        } else {
          content = String(fileData);
        }

        const now = Date.now();
        const entry = {
          path: fullAssetPath,
          parent: parentDir(fullAssetPath),
          content,
          isDir: false,
          created: now,
          modified: now,
        };
        await fsPut(entry);

        // Cache blob URL so the asset resolver can serve it immediately
        cacheAssetBlob(entry);

        // Match mrmd-server shape: return path relative to _assets/
        return { success: true, path: relativeAssetPath, deduplicated: false };
      },

      relativePath: async (assetPath, documentPath) => {
        // Match AssetService.getRelativePath(assetPath, documentPath)
        // Inputs are expected to be relative to project root, but tolerate absolute sandbox paths.

        const normalizeAssetPath = (p) => {
          const raw = String(p || '');
          const idx = raw.indexOf('/_assets/');
          if (idx >= 0) return raw.slice(idx + '/_assets/'.length);
          return raw.replace(/^\/+/, '').replace(/^_assets\//, '');
        };

        const normalizeDocPath = (p) => {
          const raw = String(p || '').replace(/^\/+/, '');
          const parts = raw.split('/').filter(Boolean);
          // If absolute sandbox path like sandbox/docs/file.md, drop project-root segment.
          if (parts.length >= 2) return parts.slice(1).join('/');
          return parts.join('/');
        };

        const assetRel = normalizeAssetPath(assetPath);
        const docRel = normalizeDocPath(documentPath);
        const docDir = docRel.includes('/') ? docRel.slice(0, docRel.lastIndexOf('/')) : '';

        const fromParts = docDir ? docDir.split('/').filter(Boolean) : [];
        const toParts = ['_assets', ...assetRel.split('/').filter(Boolean)];

        let common = 0;
        while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
          common++;
        }

        const ups = fromParts.length - common;
        const downs = toParts.slice(common);
        const relative = '../'.repeat(ups) + downs.join('/');
        return relative || '_assets/' + assetRel;
      },

      orphans: async () => [],

      delete: async (projectRoot, assetPath) => {
        projectRoot = projectRoot || SANDBOX_ROOT;
        const raw = String(assetPath || '');
        const idx = raw.indexOf('/_assets/');
        const rel = idx >= 0
          ? raw.slice(idx + '/_assets/'.length)
          : raw.replace(/^\/+/, '').replace(/^_assets\//, '');
        const full = normalizePath(projectRoot + '/_assets/' + rel);

        const blobUrl = assetBlobCache.get(full);
        if (blobUrl) {
          try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
          assetBlobCache.delete(full);
        }

        await fsDelete(full);
        return { success: true };
      },
    },

    // ====================================================================
    // Data Loss Prevention
    // ====================================================================

    onSyncServerDied: (callback) => {
      eventHandlers['sync-server-died'] = [callback];
    },

    onOpenWithFile: () => {
      // No-op in browser
    },
  };

  // ========================================================================
  // Initialize on load
  // ========================================================================

  seedDefaultProject().then(() => {
    console.log('[browser-shim] electronAPI shim loaded (sandbox mode)');
  });

  // Expose sandbox utilities
  window.MRMD_BROWSER_SHIM = {
    getDB,
    fsGet,
    fsPut,
    fsDelete,
    fsListPrefix,
    emit,
    SANDBOX_ROOT,
  };

})();
