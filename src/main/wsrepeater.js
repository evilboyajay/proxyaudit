'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

// Headers the ws client generates itself for the upgrade; copying the
// captured values would break the handshake (e.g. a stale Sec-WebSocket-Key).
const SKIP = new Set([
  'host',
  'connection',
  'upgrade',
  'content-length',
  'transfer-encoding',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-accept',
  'proxy-connection',
  'keep-alive',
]);

/**
 * WebSocket Repeater: Burp-style manual WebSocket connections. Each Repeater
 * tab owns one connection (keyed by the renderer's tab id), opened with an
 * editable handshake (cookies, auth, origin, subprotocols) and kept open so
 * the user can send frames and watch replies.
 *
 * Events:
 *   'state' ({ id, state, detail })   state: connecting | open | closed | error
 *   'frame' ({ id, frame })           frame: { ts, direction, binary, length, data }
 *                                     direction 'outgoing' = to server
 */
class WsRepeater extends EventEmitter {
  constructor() {
    super();
    this.conns = new Map();
  }

  connect(id, spec = {}) {
    this.close(id);
    let url;
    try {
      url = new URL(String(spec.url || '').trim());
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('URL must be ws:// or wss://');
    } catch (e) {
      return Promise.resolve({ ok: false, error: e.message || 'Invalid URL' });
    }

    const headers = {};
    let protocols;
    for (const [k, v] of Object.entries(spec.headers || {})) {
      const lk = k.toLowerCase();
      if (SKIP.has(lk) || v == null) continue;
      if (lk === 'sec-websocket-protocol') {
        protocols = String(v).split(',').map((s) => s.trim()).filter(Boolean);
        continue;
      }
      headers[k] = v;
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = (r) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      let ws;
      try {
        ws = new WebSocket(url.toString(), protocols, {
          headers,
          rejectUnauthorized: false, // pentest tool: targets often use self-signed certs
          handshakeTimeout: 15000,
          perMessageDeflate: true,
        });
      } catch (e) {
        done({ ok: false, error: e.message });
        return;
      }
      this.conns.set(id, ws);
      // After a reconnect the old socket's late events must not leak into
      // the tab: only the current socket (or a user-closed one) reports.
      const current = () => this.conns.get(id) === ws || !this.conns.has(id);
      this.emit('state', { id, state: 'connecting', detail: url.toString() });

      ws.on('open', () => {
        this.emit('state', { id, state: 'open', detail: ws.protocol ? `subprotocol ${ws.protocol}` : '' });
        done({ ok: true, protocol: ws.protocol || '' });
      });
      ws.on('message', (data, isBinary) => {
        if (!current()) return;
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat([].concat(data));
        this.emit('frame', {
          id,
          frame: {
            ts: Date.now(),
            direction: 'incoming',
            binary: !!isBinary,
            length: buf.length,
            data: isBinary ? buf.toString('base64') : buf.toString('utf8'),
          },
        });
      });
      ws.on('unexpected-response', (_req, res) => {
        // Server refused the upgrade: report the HTTP status like Burp does.
        const msg = `Handshake rejected: HTTP ${res.statusCode} ${res.statusMessage || ''}`.trim();
        res.resume();
        if (current()) this.emit('state', { id, state: 'error', detail: msg });
        done({ ok: false, error: msg });
        try {
          ws.terminate();
        } catch (_) {
          /* ignore */
        }
      });
      ws.on('error', (err) => {
        if (current()) this.emit('state', { id, state: 'error', detail: err.message });
        done({ ok: false, error: err.message });
      });
      ws.on('close', (code, reason) => {
        const isCurrent = current();
        if (this.conns.get(id) === ws) this.conns.delete(id);
        const why = reason && reason.length ? ` ${reason.toString()}` : '';
        if (isCurrent) this.emit('state', { id, state: 'closed', detail: `code ${code}${why}` });
        done({ ok: false, error: `Closed (code ${code})${why}` });
      });
    });
  }

  send(id, data, opts = {}) {
    const ws = this.conns.get(id);
    if (!ws || ws.readyState !== WebSocket.OPEN) return { ok: false, error: 'Not connected' };
    let payload = String(data == null ? '' : data);
    let binary = false;
    if (opts.binary) {
      payload = Buffer.from(payload.replace(/\s+/g, ''), 'base64');
      binary = true;
    }
    ws.send(payload, { binary });
    const length = binary ? payload.length : Buffer.byteLength(payload);
    const frame = {
      ts: Date.now(),
      direction: 'outgoing',
      binary,
      length,
      data: binary ? payload.toString('base64') : payload,
    };
    this.emit('frame', { id, frame });
    return { ok: true, frame };
  }

  close(id) {
    const ws = this.conns.get(id);
    if (!ws) return { ok: true };
    this.conns.delete(id);
    try {
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close(1000);
    } catch (_) {
      /* ignore */
    }
    return { ok: true };
  }

  closeAll() {
    for (const id of Array.from(this.conns.keys())) this.close(id);
  }
}

module.exports = { WsRepeater };
