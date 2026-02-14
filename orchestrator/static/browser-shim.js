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
  const CURRENT_SEED_VERSION = 2; // Bump when DEFAULT_WELCOME_DOC changes

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

## What works here

- **JavaScript** and **HTML** — instant, runs in browser
- **Python** — via Pyodide (WebAssembly), with numpy/pandas/matplotlib
- **R** — via WebR (WebAssembly), with base R packages
- **Files & folders** — saved in IndexedDB (this browser only)
- **Themes** — use the theme picker in the bottom bar
- **Navigation** — Cmd/Ctrl+P to open files, sidebar for project tree

## Want more?

[Sign in](/) for Bash, Julia, terminal access, AI commands,
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
  window.fetch = function (input, init) {
    let url = typeof input === 'string' ? input : input?.url;
    // Block requests to localhost services — they don't exist in sandbox
    const match = url && url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//);
    if (match) {
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

  function getAllSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function saveAllSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
  // FSML Navigation Builder
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
      success: false,
      error: 'AI not available in sandbox. Paste your API key in Settings to enable.',
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
        return Promise.resolve(true);
      },

      getApiKey: (provider) => {
        const keys = getSetting('apiKeys', {});
        return Promise.resolve(keys[provider] || '');
      },

      hasApiKey: (provider) => {
        const keys = getSetting('apiKeys', {});
        return Promise.resolve(Boolean(keys[provider]));
      },

      getApiProviders: () => Promise.resolve([
        { id: 'anthropic', name: 'Anthropic', models: ['claude-sonnet-4-20250514'] },
        { id: 'openai', name: 'OpenAI', models: ['gpt-4o'] },
      ]),

      getQualityLevels: () => Promise.resolve([
        { id: 'fast', name: 'Fast', model: 'claude-sonnet-4-20250514' },
        { id: 'balanced', name: 'Balanced', model: 'claude-sonnet-4-20250514' },
        { id: 'best', name: 'Best', model: 'claude-sonnet-4-20250514' },
      ]),

      setQualityLevelModel: () => Promise.resolve(true),
      getCustomSections: () => Promise.resolve([]),
      addCustomSection: () => Promise.resolve({ id: 'stub', name: 'Section' }),
      removeCustomSection: () => Promise.resolve(true),
      addCustomCommand: () => Promise.resolve({ id: 'stub', name: 'Command' }),
      updateCustomCommand: () => Promise.resolve(true),
      removeCustomCommand: () => Promise.resolve(true),
      getAllCustomCommands: () => Promise.resolve([]),
      getDefaults: () => Promise.resolve({}),
      setDefaults: () => Promise.resolve(true),
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
          return { success: false, error: 'Source not found' };
        }

        // If directory, move all children
        if (entry.isDir) {
          const children = await fsListPrefix(fullFrom + '/');
          for (const child of children) {
            const newChildPath = fullTo + child.path.slice(fullFrom.length);
            await ensureParentDirs(newChildPath);
            await fsPut({ ...child, path: newChildPath, parent: parentDir(newChildPath) });
            await fsDelete(child.path);
          }
        }

        await ensureParentDirs(fullTo);
        await fsPut({ ...entry, path: fullTo, parent: parentDir(fullTo), modified: Date.now() });
        await fsDelete(fullFrom);

        emit('project:changed', { projectRoot });
        return { success: true, from: fromPath, to: toPath };
      },

      reorder: async (projectRoot, sourcePath, targetPath, position) => {
        // Reordering is a no-op for IndexedDB (ordering is managed by the nav tree)
        // The editor will just refresh the nav tree on next project.get()
        console.log('[browser-shim] file.reorder stub:', sourcePath, '->', targetPath, position);
        return { success: true };
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
          path: e.path,
          name: baseName(e.path),
          size: e.content ? e.content.length : 0,
          modified: e.modified,
        }));
      },

      save: async (projectRoot, fileData, filename) => {
        projectRoot = projectRoot || SANDBOX_ROOT;
        const assetsDir = projectRoot + '/_assets';
        const assetPath = normalizePath(assetsDir + '/' + filename);
        await ensureParentDirs(assetPath);

        // fileData may be base64 string or Uint8Array
        let content;
        if (typeof fileData === 'string') {
          content = fileData; // Store base64 as-is
        } else if (fileData instanceof Uint8Array) {
          // Convert to base64 for storage
          content = btoa(String.fromCharCode.apply(null, fileData));
        } else {
          content = String(fileData);
        }

        const now = Date.now();
        await fsPut({
          path: assetPath,
          parent: assetsDir,
          content,
          isDir: false,
          created: now,
          modified: now,
        });

        return { success: true, path: assetPath };
      },

      relativePath: async (assetPath, documentPath) => {
        // Simple relative path calculation
        const assetParts = assetPath.split('/');
        const docParts = documentPath.split('/');
        docParts.pop(); // Remove filename

        let common = 0;
        while (common < assetParts.length && common < docParts.length &&
          assetParts[common] === docParts[common]) {
          common++;
        }

        const ups = docParts.length - common;
        const downs = assetParts.slice(common);
        const relative = '../'.repeat(ups) + downs.join('/');
        return relative;
      },

      orphans: async () => [],

      delete: async (projectRoot, assetPath) => {
        await fsDelete(assetPath);
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
