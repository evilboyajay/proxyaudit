'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

/**
 * ExtensionBridge — a local control channel to the ProxyAudit Chrome extension.
 *
 * The extension (MV3 service worker) connects here over a loopback WebSocket.
 * ProxyAudit tells it WHERE TO GO and WHAT TO DO (navigate, read links, click,
 * read the page, set the proxy); the extension does the actual visiting and
 * info-gathering inside the user's own Chrome and streams results back. This is
 * the user's requested model: "all visiting and getting info is done by our
 * Chrome extension, but what to do and where to go is sent by our Claude build."
 *
 * Exposes the same surface BrowserControl does (navigate/getLinks/click/
 * evaluate/currentUrl/crawl) so it can be used interchangeably by the agent's
 * MCP tools, plus readPage/setProxy/clearProxy that the extension adds.
 *
 * Authorized testing only — this drives the user's own browser against targets
 * the user is authorized to test.
 */
const DEFAULT_PORT = 9444;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class ExtensionBridge extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.port = opts.port || DEFAULT_PORT;
    this.proxyPort = opts.proxyPort || 8080; // current proxy port (kept fresh by main)
    this.autoProxy = opts.autoProxy !== false; // tell the extension to route Chrome through our proxy
    this.wss = null;
    this.socket = null; // the single live extension connection
    this.info = null; // last {version, ...} the extension announced
    this._seq = 1;
    this._pending = new Map(); // id -> {resolve, reject, timer}
  }

  get connected() {
    return !!(this.socket && this.socket.readyState === WebSocket.OPEN);
  }

  isConnected() {
    return this.connected;
  }

  status() {
    return { running: !!this.wss, connected: this.connected, port: this.port, info: this.info };
  }

  /** Start the WebSocket server. Resolves once it is listening (or errors). */
  start() {
    if (this.wss) return Promise.resolve(this.status());
    return new Promise((resolve, reject) => {
      const wss = new WebSocket.Server({ host: '127.0.0.1', port: this.port });
      wss.on('listening', () => {
        this.wss = wss;
        this.emit('listening', this.port);
        resolve(this.status());
      });
      wss.on('error', (err) => {
        if (!this.wss) reject(err);
        else this.emit('error', err);
      });
      wss.on('connection', (ws) => this._onConnection(ws));
    });
  }

  _onConnection(ws) {
    // Only one controller at a time; replace any stale socket.
    if (this.socket && this.socket !== ws) {
      try { this.socket.close(); } catch (_) {}
    }
    this.socket = ws;
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('close', () => {
      if (this.socket === ws) {
        this.socket = null;
        this.info = null;
        this._rejectAll('extension disconnected');
        this.emit('disconnected');
      }
    });
    ws.on('error', () => {});
    // Handshake: tell the extension our proxy port so it can route Chrome through us.
    this._raw({ type: 'hello', proxyPort: this.proxyPort, autoProxy: this.autoProxy });
    this.emit('connected');
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.type === 'ready') {
      this.info = msg.info || { version: msg.version };
      this.emit('ready', this.info);
      return;
    }
    if (msg.type === 'event') {
      this.emit('page-event', msg);
      return;
    }
    if (msg.type === 'result' && msg.id != null) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok === false) p.reject(new Error(msg.error || 'extension error'));
      else p.resolve(msg.data);
    }
  }

  _raw(obj) {
    if (!this.connected) return false;
    try { this.socket.send(JSON.stringify(obj)); return true; } catch (_) { return false; }
  }

  _rejectAll(reason) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this._pending.clear();
  }

  /** Send a command to the extension and await its correlated result. */
  send(cmd, params = {}, timeoutMs = 30000) {
    if (!this.connected) {
      return Promise.reject(new Error('ProxyAudit extension is not connected. Load it in Chrome and keep that Chrome open.'));
    }
    const id = this._seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('extension command timed out: ' + cmd));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._raw({ type: 'cmd', id, cmd, params });
    });
  }

  /** Push the current proxy port to the extension (call when the port changes). */
  setProxyPort(port, autoProxy) {
    this.proxyPort = port || this.proxyPort;
    if (autoProxy != null) this.autoProxy = !!autoProxy;
    this._raw({ type: 'hello', proxyPort: this.proxyPort, autoProxy: this.autoProxy });
  }

  // ---- BrowserControl-compatible surface (used by the agent's MCP tools) ----

  async navigate(url, timeoutMs = 30000) {
    const r = await this.send('navigate', { url }, timeoutMs);
    return { ok: true, url: (r && r.url) || url };
  }

  async getLinks(sameOriginOnly = true) {
    const r = await this.send('getLinks', { sameOrigin: sameOriginOnly });
    return (r && r.links) || [];
  }

  async click(selector) {
    return await this.send('click', { selector });
  }

  async evaluate(expression) {
    const r = await this.send('evaluate', { expression });
    return r && r.value;
  }

  async currentUrl() {
    try { const r = await this.send('currentUrl', {}); return r && r.url; } catch (_) { return null; }
  }

  /** Read the current page: title, final URL, visible text (truncated), links. */
  async readPage(maxChars = 12000) {
    return await this.send('readPage', { maxChars });
  }

  async setProxy(port) {
    return await this.send('setProxy', { proxyPort: port || this.proxyPort });
  }

  async clearProxy() {
    return await this.send('clearProxy', {});
  }

  /**
   * Breadth-first crawl through the user's Chrome (same logic as BrowserControl)
   * — every page is actually loaded in the extension's tab and, when autoProxy
   * is on, captured by the proxy.
   */
  async crawl(startUrl, opts = {}) {
    const maxPages = Math.min(opts.maxPages || 40, 300);
    let origin;
    try { origin = new URL(startUrl).origin; } catch (_) { return { error: 'Invalid start URL' }; }

    const visited = new Set();
    const queue = [startUrl];
    const pages = [];
    while (queue.length && visited.size < maxPages) {
      const url = queue.shift();
      if (visited.has(url)) continue;
      visited.add(url);
      try {
        await this.navigate(url);
        await delay(400);
        const links = await this.getLinks(true);
        pages.push({ url, links: links.length });
        for (const l of links) {
          if (!visited.has(l) && l.startsWith(origin) && queue.length + visited.size < maxPages) {
            queue.push(l);
          }
        }
      } catch (e) {
        pages.push({ url, error: String(e && e.message ? e.message : e) });
      }
    }
    return { crawled: pages.length, startUrl, pages };
  }

  async close() {
    this._rejectAll('bridge closing');
    if (this.socket) { try { this.socket.close(); } catch (_) {} this.socket = null; }
    if (this.wss) { try { this.wss.close(); } catch (_) {} this.wss = null; }
  }
}

module.exports = { ExtensionBridge, EXTENSION_PORT: DEFAULT_PORT };
