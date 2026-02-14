/**
 * pyodide-runtime.js — Python execution in the browser via Pyodide (WebAssembly)
 *
 * Implements the mrmd runtime interface:
 *   - supports(language) → boolean
 *   - execute(code, language) → {stdout, stderr, result?, error?, success}
 *   - executeStreaming(code, language, onChunk, onStdinRequest?) → same
 *
 * Lazy-loads Pyodide on first execution (~10MB, cached by browser).
 * Variables persist across cells within the same session.
 */

(function () {
  'use strict';

  if (!window.MRMD_SANDBOX) return;

  const PYODIDE_VERSION = '0.27.0';
  const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

  let pyodidePromise = null;
  let pyodideReady = false;

  /**
   * Load Pyodide (once). Returns the pyodide instance.
   * Subsequent calls return the cached promise.
   */
  function ensurePyodide(onProgress) {
    if (!pyodidePromise) {
      pyodidePromise = (async () => {
        // Load the Pyodide loader script if not already present
        if (!window.loadPyodide) {
          if (onProgress) onProgress('Loading Python runtime...\n');
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = PYODIDE_CDN + 'pyodide.js';
            script.onload = resolve;
            script.onerror = () => reject(new Error('Failed to load Pyodide script'));
            document.head.appendChild(script);
          });
        }

        if (onProgress) onProgress('Initializing Python...\n');
        const pyodide = await window.loadPyodide({
          indexURL: PYODIDE_CDN,
        });

        // Pre-load micropip for package installation
        await pyodide.loadPackage('micropip');

        pyodideReady = true;
        if (onProgress) onProgress('Python ready.\n');
        console.log('[pyodide-runtime] Pyodide loaded:', pyodide.version);
        return pyodide;
      })();
    }
    return pyodidePromise;
  }

  // Supported language aliases
  const PYTHON_LANGS = new Set(['python', 'py', 'python3', 'cpython']);

  /**
   * The Pyodide runtime object, compatible with editor.registerRuntime()
   */
  const pyodideRuntime = {
    supports(language) {
      return PYTHON_LANGS.has(language.toLowerCase());
    },

    async execute(code, language) {
      try {
        const pyodide = await ensurePyodide();
        return await runPython(pyodide, code);
      } catch (err) {
        return {
          stdout: '',
          stderr: err.message || String(err),
          success: false,
          error: { type: 'PyodideError', message: err.message },
        };
      }
    },

    async executeStreaming(code, language, onChunk, onStdinRequest) {
      let accumulated = '';

      function appendOutput(text) {
        accumulated += text;
        onChunk(text, accumulated, false);
      }

      try {
        // Lazy-load with progress
        const pyodide = await ensurePyodide(
          pyodideReady ? null : (msg) => appendOutput(msg)
        );

        const result = await runPython(pyodide, code, appendOutput);

        // Final chunk
        onChunk('', accumulated + (result.stdout || ''), true);

        return result;
      } catch (err) {
        const errMsg = err.message || String(err);
        accumulated += errMsg;
        onChunk(errMsg, accumulated, true);
        return {
          stdout: '',
          stderr: errMsg,
          success: false,
          error: { type: 'PyodideError', message: errMsg },
        };
      }
    },
  };

  /**
   * Execute Python code via Pyodide with stdout/stderr capture.
   */
  async function runPython(pyodide, code, onOutput) {
    let stdout = '';
    let stderr = '';

    // Redirect stdout/stderr
    pyodide.setStdout({
      batched: (text) => {
        stdout += text + '\n';
        if (onOutput) onOutput(text + '\n');
      },
    });
    pyodide.setStderr({
      batched: (text) => {
        stderr += text + '\n';
        if (onOutput) onOutput(text + '\n');
      },
    });

    try {
      // Auto-install packages referenced by import statements
      await autoInstallPackages(pyodide, code, onOutput);

      // Run the code
      const rawResult = await pyodide.runPythonAsync(code);

      // Convert result to string
      let resultStr = '';
      if (rawResult !== undefined && rawResult !== null) {
        try {
          // Use Python's repr() for nice formatting
          resultStr = rawResult.toString();
          // Clean up PyProxy if needed
          if (rawResult.destroy) rawResult.destroy();
        } catch {
          resultStr = String(rawResult);
        }
      }

      return {
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        result: resultStr || undefined,
        success: true,
      };
    } catch (err) {
      // Pyodide wraps Python exceptions
      const message = err.message || String(err);
      stderr += message;
      if (onOutput) onOutput(message + '\n');

      return {
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        success: false,
        error: { type: 'PythonError', message },
      };
    }
  }

  /**
   * Auto-detect imports and install missing packages via micropip.
   * Supports: import X, from X import Y, import X as Z
   */
  async function autoInstallPackages(pyodide, code, onOutput) {
    // Extract import names
    const importPattern = /^(?:from\s+(\w[\w.]*)\s+import|import\s+(\w[\w.]*))/gm;
    const packages = new Set();
    let match;

    while ((match = importPattern.exec(code)) !== null) {
      const pkg = (match[1] || match[2]).split('.')[0];
      packages.add(pkg);
    }

    if (packages.size === 0) return;

    // Filter out stdlib modules (Pyodide knows which are built-in)
    const micropip = pyodide.pyimport('micropip');

    for (const pkg of packages) {
      try {
        // Check if already available
        pyodide.pyimport(pkg);
      } catch {
        // Not available — try to install
        try {
          if (onOutput) onOutput(`Installing ${pkg}...\n`);
          await micropip.install(pkg);
          if (onOutput) onOutput(`Installed ${pkg}\n`);
        } catch (installErr) {
          // Package might not exist on PyPI or isn't pure Python
          // Silently skip — the import will fail with a clear error anyway
          console.warn(`[pyodide] Failed to auto-install ${pkg}:`, installErr.message);
        }
      }
    }
  }

  // ========================================================================
  // Expose for registration by sandbox-bridge.js
  // ========================================================================

  window.MRMD_PYODIDE_RUNTIME = pyodideRuntime;

  console.log('[pyodide-runtime] Python runtime available (lazy-loaded on first use)');

})();
