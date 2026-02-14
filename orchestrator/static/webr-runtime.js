/**
 * webr-runtime.js — R execution in the browser via WebR (WebAssembly)
 *
 * Implements the mrmd runtime interface:
 *   - supports(language) → boolean
 *   - execute(code, language) → {stdout, stderr, result?, error?, success}
 *   - executeStreaming(code, language, onChunk, onStdinRequest?) → same
 *
 * Lazy-loads WebR on first R cell execution (~20MB, cached by browser).
 * Variables persist across cells within the same session.
 *
 * WebR: https://webr.r-wasm.org/
 */

(function () {
  'use strict';

  if (!window.MRMD_SANDBOX) return;

  const WEBR_CDN = 'https://webr.r-wasm.org/v0.4.4/';

  let webrPromise = null;
  let webrReady = false;

  /**
   * Load WebR (once). Returns the WebR instance.
   */
  function ensureWebR(onProgress) {
    if (!webrPromise) {
      webrPromise = (async () => {
        if (onProgress) onProgress('Loading R runtime...\n');

        // Dynamic import of WebR ES module
        const { WebR } = await import(WEBR_CDN + 'webr.mjs');

        if (onProgress) onProgress('Initializing R...\n');
        const webR = new WebR();
        await webR.init();

        webrReady = true;
        if (onProgress) onProgress('R ready.\n');
        console.log('[webr-runtime] WebR loaded');
        return webR;
      })();
    }
    return webrPromise;
  }

  // Supported language aliases
  const R_LANGS = new Set(['r', 'rlang', 'rscript']);

  /**
   * The WebR runtime object, compatible with editor.registerRuntime()
   */
  const webrRuntime = {
    supports(language) {
      return R_LANGS.has(language.toLowerCase());
    },

    async execute(code, language) {
      try {
        const webR = await ensureWebR();
        return await runR(webR, code);
      } catch (err) {
        return {
          stdout: '',
          stderr: err.message || String(err),
          success: false,
          error: { type: 'WebRError', message: err.message },
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
        const webR = await ensureWebR(
          webrReady ? null : (msg) => appendOutput(msg)
        );

        const result = await runR(webR, code, appendOutput);

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
          error: { type: 'WebRError', message: errMsg },
        };
      }
    },
  };

  /**
   * Execute R code via WebR with stdout/stderr capture.
   */
  async function runR(webR, code, onOutput) {
    let stdout = '';
    let stderr = '';

    try {
      // Use shelter for automatic memory management
      const shelter = await new webR.Shelter();

      try {
        // Capture output using R's capture.output + tryCatch
        const result = await shelter.captureR(code, {
          withAutoprint: true,
          captureStreams: true,
          captureConditions: true,
        });

        // Process output
        for (const out of result.output) {
          const text = typeof out.data === 'string' ? out.data : String(out.data || '');
          if (out.type === 'stdout') {
            stdout += text + '\n';
            if (onOutput) onOutput(text + '\n');
          } else if (out.type === 'stderr' || out.type === 'message') {
            stderr += text + '\n';
            if (onOutput) onOutput(text + '\n');
          }
        }

        // Process conditions (warnings, messages)
        // Note: conditions from captureR are {type, data} where data is an RObject
        for (const cond of (result.conditions || [])) {
          try {
            let condMsg = '';
            if (typeof cond.message === 'string') {
              condMsg = cond.message;
            } else if (cond.data && typeof cond.data.toString === 'function') {
              condMsg = cond.data.toString();
            }

            if (cond.type === 'warning') {
              const msg = `Warning: ${condMsg}\n`;
              stderr += msg;
              if (onOutput) onOutput(msg);
            } else if (cond.type === 'message') {
              const msg = condMsg + '\n';
              stderr += msg;
              if (onOutput) onOutput(msg);
            }
          } catch {
            // Skip conditions we can't process
          }
        }

        // Get the result value
        let resultStr = '';
        if (result.result && result.result.type !== 'null') {
          try {
            const jsResult = await result.result.toJs();
            if (jsResult !== null && jsResult !== undefined) {
              if (Array.isArray(jsResult.values)) {
                resultStr = jsResult.values.join(' ');
              } else {
                resultStr = String(jsResult);
              }
            }
          } catch {
            // Some R objects can't be converted to JS — that's fine
          }
        }

        return {
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          result: resultStr || undefined,
          success: true,
        };
      } finally {
        shelter.purge();
      }
    } catch (err) {
      const message = err.message || String(err);
      stderr += message;
      if (onOutput) onOutput(message + '\n');

      return {
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        success: false,
        error: { type: 'RError', message },
      };
    }
  }

  // ========================================================================
  // Expose for registration by sandbox-bridge.js
  // ========================================================================

  window.MRMD_WEBR_RUNTIME = webrRuntime;

  console.log('[webr-runtime] R runtime available (lazy-loaded on first use)');

})();
