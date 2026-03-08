/**
 * Runtime Tunnel Client — consumer side for the web editor container
 *
 * Connects to the relay's tunnel room as a "consumer". When the Electron
 * desktop app is online (the "provider"), this client routes MRP traffic
 * through the tunnel instead of to local runtimes.
 *
 * Provides:
 *   - isAvailable()         — is the Electron provider connected?
 *   - startRuntime(config)  — ask Electron to start runtimes for a document
 *   - getSharedSyncInfo(config) — ask Electron for local sync port/doc info
 *   - httpProxy(port, req, res)    — tunnel HTTP request to Electron
 *   - wsProxy(port, path, clientWs) — tunnel WebSocket to Electron
 *   - isTunnelPort(port)    — is this port served by the tunnel?
 */

import { WebSocket } from 'ws';

let _nextId = 1;
function nextId() { return `tc-${_nextId++}`; }

export class RuntimeTunnelClient {
  constructor(opts) {
    this.relayUrl = opts.relayUrl;
    this.userId = opts.userId;
    this.ws = null;
    this._destroyed = false;
    this._reconnectTimer = null;
    this._providerAvailable = false;
    this._provider = null;
    this._activeMachineId = null;
    this._machines = [];
    this._tunnelPorts = new Set();
    this._pending = new Map();
    this._wsSessions = new Map();
    this._cloudToLocalRoots = new Map();
  }

  start() { this._connect(); }

  _connect() {
    if (this._destroyed) return;
    const url = `${this.relayUrl}/tunnel/${encodeURIComponent(this.userId)}?role=consumer`;
    try {
      this.ws = new WebSocket(url, { headers: { 'X-User-Id': this.userId } });
    } catch {
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      console.log('[tunnel-client] Connected to relay as consumer');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(typeof data === 'string' ? data : data.toString());
        this._handleMessage(msg);
      } catch (err) {
        console.error('[tunnel-client] Bad message:', err.message);
      }
    });

    this.ws.on('close', () => {
      this._providerAvailable = false;
      this._provider = null;
      this._activeMachineId = null;
      this._machines = [];
      this._tunnelPorts.clear();
      this._cloudToLocalRoots.clear();
      for (const [, handler] of this._pending) handler.reject?.(new Error('Tunnel disconnected'));
      this._pending.clear();
      for (const [, session] of this._wsSessions) {
        try { session.clientWs?.close(); } catch {}
      }
      this._wsSessions.clear();
      if (!this._destroyed) this._scheduleReconnect();
    });

    this.ws.on('error', () => {});
  }

  _scheduleReconnect() {
    if (this._destroyed || this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, 5000);
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(obj)); } catch {}
    }
  }

  _handleMessage(msg) {
    switch (msg.t) {
      case 'provider-status':
        this._providerAvailable = msg.available;
        this._provider = msg.provider || this._provider;
        this._activeMachineId = msg.activeMachineId || null;
        this._machines = msg.machines || [];
        break;
      case 'provider-gone':
        this._providerAvailable = false;
        this._provider = null;
        this._activeMachineId = null;
        this._machines = [];
        this._tunnelPorts.clear();
        break;
      case 'provider-info':
        this._providerAvailable = true;
        this._provider = {
          ...(this._provider || {}),
          machineId: msg.machineId || this._provider?.machineId || null,
          machineName: msg.machineName || this._provider?.machineName || null,
          hostname: msg.hostname || this._provider?.hostname || null,
          capabilities: msg.capabilities || this._provider?.capabilities || [],
        };
        break;
      case 'runtimes-list': this._handleRuntimesList(msg); break;
      case 'runtime-started': this._handleRuntimeStarted(msg); break;
      case 'shared-sync-info': this._resolvePending(msg.id, msg.sync); break;
      case 'runtime-update': this._handleRuntimeUpdate(msg); break;
      case 'runtime-update-error': this._handleRuntimeUpdateError(msg); break;
      case 'runtime-stopped': this._resolvePending(msg.id, { success: msg.success }); break;
      case 'runtime-error': this._resolvePending(msg.id, null, msg.error); break;
      case 'http-res': this._handleHttpRes(msg); break;
      case 'http-chunk': this._handleHttpChunk(msg); break;
      case 'http-end': this._handleHttpEnd(msg); break;
      case 'http-error': this._resolvePending(msg.id, null, msg.error); break;
      case 'ws-opened': this._handleWsOpened(msg); break;
      case 'ws-msg': this._handleWsMsg(msg); break;
      case 'ws-close': this._handleWsSessionClose(msg); break;
      case 'ws-error': this._handleWsError(msg); break;
      case 'voice-result': this._resolvePending(msg.id, msg.result, msg.error); break;
    }
  }

  isAvailable() {
    return this._providerAvailable && this.ws?.readyState === WebSocket.OPEN;
  }

  isTunnelPort(port) {
    return this._tunnelPorts.has(Number(port));
  }

  async waitForAvailability(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.isAvailable()) return true;
      await new Promise(r => setTimeout(r, 150));
    }
    return this.isAvailable();
  }

  async startRuntime(config) {
    if (!this.isAvailable()) throw new Error('Tunnel provider not available');
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('Runtime start timeout'));
      }, 30000);
      this._pending.set(id, {
        requestContext: { projectRoot: config.projectRoot || null, documentPath: config.documentPath || null },
        resolve: (result) => { clearTimeout(timeout); this._pending.delete(id); resolve(result); },
        reject: (err) => { clearTimeout(timeout); this._pending.delete(id); reject(typeof err === 'string' ? new Error(err) : err); },
      });
      this._send({
        t: 'start-runtime', id,
        name: config.name || null,
        language: config.language || null,
        cwd: config.cwd || null,
        venv: config.venv || null,
        documentPath: config.documentPath || null,
        projectRoot: config.projectRoot || null,
        sharedProject: config.sharedProject || null,
        sharedDocPath: config.sharedDocPath || null,
        projectConfig: config.projectConfig || null,
        frontmatter: config.frontmatter || null,
      });
    });
  }

  async getSharedSyncInfo(config) {
    if (!this.isAvailable()) throw new Error('Tunnel provider not available');
    const id = nextId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('Shared sync info timeout'));
      }, 15000);
      this._pending.set(id, {
        resolve: (result) => { clearTimeout(timeout); this._pending.delete(id); resolve(result); },
        reject: (err) => { clearTimeout(timeout); this._pending.delete(id); reject(typeof err === 'string' ? new Error(err) : err); },
      });
      this._send({ t: 'shared-sync-info', id, project: config.sharedProject || null, docPath: config.sharedDocPath || null });
    });
  }

  async httpProxy(port, req, res) {
    if (!this.isAvailable()) {
      res.status(502).json({ error: 'Tunnel provider not available' });
      return;
    }
    const id = nextId();
    const targetPath = req.url;
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (key.toLowerCase().startsWith('x-') || key.toLowerCase() === 'content-type' || key.toLowerCase() === 'accept') headers[key] = value;
    }
    let body = undefined;
    if (!['GET', 'HEAD'].includes(req.method)) body = JSON.stringify(req.body);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        if (!res.headersSent) res.status(504).json({ error: 'Tunnel request timeout' });
        resolve();
      }, 60000);
      this._pending.set(id, {
        onHeaders: (status, resHeaders) => {
          res.status(status);
          for (const [k, v] of Object.entries(resHeaders || {})) {
            if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k.toLowerCase())) res.setHeader(k, v);
          }
        },
        onChunk: (data) => res.write(Buffer.from(data, 'base64')),
        resolve: () => { clearTimeout(timeout); this._pending.delete(id); res.end(); resolve(); },
        reject: (err) => { clearTimeout(timeout); this._pending.delete(id); if (!res.headersSent) res.status(502).json({ error: typeof err === 'string' ? err : err?.message || 'Tunnel error' }); else res.end(); resolve(); },
      });
      this._send({ t: 'http-req', id, port, method: req.method, path: targetPath, headers, body });
    });
  }

  wsProxy(port, path, clientWs) {
    if (!this.isAvailable()) {
      clientWs.close(1013, 'Tunnel provider not available');
      return;
    }
    const id = nextId();
    this._wsSessions.set(id, { clientWs });
    clientWs.on('message', (data, isBinary) => {
      if (isBinary) this._send({ t: 'ws-msg', id, data: Buffer.from(data).toString('base64'), bin: true });
      else this._send({ t: 'ws-msg', id, data: data.toString(), bin: false });
    });
    clientWs.on('close', () => { this._send({ t: 'ws-close', id }); this._wsSessions.delete(id); });
    clientWs.on('error', () => { this._send({ t: 'ws-close', id }); this._wsSessions.delete(id); });
    this._send({ t: 'ws-open', id, port, path });
  }

  _handleRuntimesList(msg) {
    const handler = this._pending.get(msg.id);
    if (!handler) return;
    const runtimes = msg.runtimes || [];
    for (const info of runtimes) if (info?.port) this._tunnelPorts.add(info.port);
    handler.resolve(runtimes);
  }

  _handleRuntimeStarted(msg) {
    const runtimes = msg.runtimes || {};
    this._registerRuntimePorts(runtimes);
    const handler = this._pending.get(msg.id);
    if (!handler) return;
    const cloudRoot = handler.requestContext?.projectRoot || null;
    this._learnCloudToLocalRoot(cloudRoot, runtimes);
    handler.resolve(runtimes);
  }

  _handleRuntimeUpdate(msg) {
    const runtimes = msg.runtimes || {};
    this._registerRuntimePorts(runtimes);
    const pending = this._pending.get(msg.requestId);
    const cloudRoot = pending?.requestContext?.projectRoot || msg.projectRoot || null;
    this._learnCloudToLocalRoot(cloudRoot, runtimes);
  }

  _handleRuntimeUpdateError(msg) {
    const pending = this._pending.get(msg.requestId);
    if (pending) pending.reject(typeof msg.error === 'string' ? new Error(msg.error) : msg.error);
  }

  _registerRuntimePorts(runtimes) {
    for (const info of Object.values(runtimes || {})) if (info?.port) this._tunnelPorts.add(info.port);
  }

  _learnCloudToLocalRoot(cloudRoot, runtimes) {
    if (!cloudRoot) return;
    const first = Object.values(runtimes || {}).find(v => v?.documentPath || v?.projectRoot);
    const localRoot = first?.projectRoot || (first?.documentPath ? String(first.documentPath).replace(/\/?[^/]+$/, '') : null);
    if (localRoot) this._cloudToLocalRoots.set(cloudRoot, localRoot);
  }

  _resolvePending(id, result, error) {
    const handler = this._pending.get(id);
    if (!handler) return;
    if (error) handler.reject(error); else handler.resolve(result);
  }

  _handleHttpRes(msg) { const h = this._pending.get(msg.id); if (!h) return; h.onHeaders?.(msg.status, msg.headers); }
  _handleHttpChunk(msg) { const h = this._pending.get(msg.id); if (!h) return; h.onChunk?.(msg.data); }
  _handleHttpEnd(msg) { const h = this._pending.get(msg.id); if (!h) return; h.resolve?.(); }
  _handleWsOpened(_msg) {}
  _handleWsMsg(msg) {
    const s = this._wsSessions.get(msg.id); if (!s) return;
    try { s.clientWs.send(msg.bin ? Buffer.from(msg.data, 'base64') : msg.data, { binary: !!msg.bin }); } catch {}
  }
  _handleWsSessionClose(msg) {
    const s = this._wsSessions.get(msg.id); if (!s) return;
    try { s.clientWs.close(msg.code || 1000, msg.reason || ''); } catch {}
    this._wsSessions.delete(msg.id);
  }
  _handleWsError(msg) {
    const s = this._wsSessions.get(msg.id); if (!s) return;
    try { s.clientWs.close(1011, msg.error || 'Tunnel WS error'); } catch {}
    this._wsSessions.delete(msg.id);
  }

  stop() {
    this._destroyed = true;
    clearTimeout(this._reconnectTimer);
    try { this.ws?.close(); } catch {}
  }
}

export default RuntimeTunnelClient;
