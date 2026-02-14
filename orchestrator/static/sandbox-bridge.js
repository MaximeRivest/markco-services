/**
 * sandbox-bridge.js — Patches mrmd.drive() for local-only editing
 *
 * Loaded AFTER mrmd.iife.js but BEFORE the main app script.
 * Replaces the Yjs websocket-backed drive with one that reads/writes
 * to IndexedDB via the browser-shim virtual filesystem.
 *
 * The editor doesn't know it's in sandbox mode — it gets the same
 * editor instance from drive.open() as it would from a real sync server.
 */

(function () {
  'use strict';

  if (!window.MRMD_SANDBOX) return;

  const { fsGet, fsPut, SANDBOX_ROOT, emit } = window.MRMD_BROWSER_SHIM;

  // Save original drive for reference
  const _originalDrive = window.mrmd.drive;

  // Auto-save debounce time (ms)
  const AUTO_SAVE_DELAY = 1000;

  /**
   * Create a local drive that reads/writes IndexedDB instead of WebSocket sync.
   */
  function createLocalDrive() {
    const statusHandlers = [];
    let status = 'connected'; // Always "connected" in local mode

    return {
      url: 'local://sandbox',

      /**
       * Open a document from IndexedDB and create a full mrmd editor.
       *
       * @param {string} docName - Document name (without extension)
       * @param {string} target - CSS selector for editor container
       * @param {Object} editorOptions - Editor configuration
       * @returns {Object} Editor instance
       */
      async open(docName, target, editorOptions = {}) {
        // Resolve file path from docName
        // The app calls openFile() which returns docName (filename without .md).
        // We need to find the actual file path in IndexedDB.
        const filePath = await resolveDocPath(docName);
        let content = '';

        if (filePath) {
          const entry = await fsGet(filePath);
          content = entry?.content || '';
        }

        // Create editor using mrmd.create() (local, no Yjs sync)
        const options = {
          ...editorOptions,
          doc: content,
        };

        // Remove Yjs-specific options that don't apply locally
        delete options.ydoc;
        delete options.ytext;
        delete options.awareness;

        const editor = window.mrmd.create(target, options);

        // Store the file path on the editor for save operations
        editor._sandboxFilePath = filePath;
        editor.path = docName;

        // Set up auto-save: persist editor content to IndexedDB on changes
        let saveTimer = null;
        editor.onChange(() => {
          clearTimeout(saveTimer);
          saveTimer = setTimeout(async () => {
            const currentContent = editor.getContent();
            const savePath = editor._sandboxFilePath;
            if (!savePath) return;

            const existing = await fsGet(savePath);
            if (existing) {
              await fsPut({
                ...existing,
                content: currentContent,
                modified: Date.now(),
              });
            } else {
              // File was deleted? Recreate it.
              await fsPut({
                path: savePath,
                parent: savePath.split('/').slice(0, -1).join('/'),
                content: currentContent,
                isDir: false,
                created: Date.now(),
                modified: Date.now(),
              });
            }
          }, AUTO_SAVE_DELAY);
        });

        // Mock provider (the app expects editor.provider to exist)
        const providerHandlers = {};
        editor.provider = {
          awareness: editor.awareness || { setLocalStateField() {}, getLocalState() { return {}; } },
          synced: true,
          wsconnected: true,
          ws: null,
          on(event, fn) {
            if (!providerHandlers[event]) providerHandlers[event] = [];
            providerHandlers[event].push(fn);
            // Immediately report "connected" status
            if (event === 'status') {
              setTimeout(() => fn({ status: 'connected' }), 0);
            }
          },
          off(event, fn) {
            if (providerHandlers[event]) {
              providerHandlers[event] = providerHandlers[event].filter(h => h !== fn);
            }
          },
          once(event, fn) {
            const wrapper = (...args) => {
              this.off(event, wrapper);
              fn(...args);
            };
            this.on(event, wrapper);
          },
          emit() {},
          disconnect() {},
          connect() {},
          destroy() {},
        };

        // Wire up connection status to show as connected
        const stateManager = editor._stateManager;
        if (stateManager) {
          stateManager.updateDocument({ path: docName });
          stateManager.setConnectionStatus('connected');
        }

        return editor;
      },

      onStatus(callback) {
        statusHandlers.push(callback);
        // Immediately report connected
        setTimeout(() => callback('connected'), 0);
        return () => {
          const idx = statusHandlers.indexOf(callback);
          if (idx >= 0) statusHandlers.splice(idx, 1);
        };
      },

      getStatus() {
        return status;
      },

      destroy() {
        // Nothing to clean up locally
      },
    };
  }

  /**
   * Find the full IndexedDB path for a document name.
   * The app opens files as docName (e.g., "welcome") and we need to find
   * the matching path (e.g., "/sandbox/welcome.md").
   */
  async function resolveDocPath(docName) {
    // Try common patterns
    const candidates = [
      `${SANDBOX_ROOT}/${docName}.md`,
      `${SANDBOX_ROOT}/${docName}`,
    ];

    for (const candidate of candidates) {
      const entry = await fsGet(candidate);
      if (entry && !entry.isDir) return candidate;
    }

    // Search all entries for a match
    const { fsListPrefix } = window.MRMD_BROWSER_SHIM;
    const allEntries = await fsListPrefix(SANDBOX_ROOT);

    for (const entry of allEntries) {
      if (entry.isDir) continue;
      const name = entry.path.split('/').pop();
      const nameNoExt = name.replace(/\.md$/i, '');
      if (nameNoExt === docName || name === docName) {
        return entry.path;
      }
    }

    // Not found — create it
    const newPath = `${SANDBOX_ROOT}/${docName}.md`;
    await fsPut({
      path: newPath,
      parent: SANDBOX_ROOT,
      content: `# ${docName}\n\n`,
      isDir: false,
      created: Date.now(),
      modified: Date.now(),
    });
    return newPath;
  }

  // ========================================================================
  // Patch mrmd.drive()
  // ========================================================================

  window.mrmd.drive = function (urlOrOptions, options = {}) {
    // In sandbox mode, always return a local drive
    console.log('[sandbox-bridge] Creating local drive (IndexedDB-backed)');
    return createLocalDrive();
  };

  // ========================================================================
  // Patch openFile to also set the correct sandbox file path
  // ========================================================================

  const _originalOpenFile = window.electronAPI.openFile;
  window.electronAPI.openFile = async function (filePath) {
    const result = await _originalOpenFile(filePath);

    // Store the full path so sandbox-bridge can find it
    if (result.success) {
      window._sandboxCurrentFilePath = filePath;
    }

    return result;
  };

  console.log('[sandbox-bridge] Local drive patched (no sync server needed)');

})();
