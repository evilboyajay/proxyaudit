'use strict';

const { EventEmitter } = require('events');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const Proxy = require('http-mitm-proxy').Proxy;
const { MatchReplace } = require('../matchreplace');

const MAX_BODY_CAPTURE = 5 * 1024 * 1024; // 5 MB cap per body

function portFree(port) {
  return new Promise((res) => {
    const s = net.createServer();
    s.once('error', () => res(false));
    s.once('listening', () => s.close(() => res(true)));
    s.listen(port, '127.0.0.1');
  });
}
async function findFreePort(start) {
  for (let p = start; p < start + 25; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await portFree(p)) return p;
  }
  return start;
}

/**
 * The MITM proxy engine. Owns the http-mitm-proxy instance, captures every
 * HTTP request/response and WebSocket frame, and (optionally) pauses traffic
 * for interception. All captured data is emitted as events for the main
 * process to persist and forward to the renderer.
 *
 * Events:
 *   'flow'        (flow)            - a new request started
 *   'flow-update' (flow)           - response (or more data) attached to a flow
 *   'ws-open'     (conn)           - a websocket connection was established
 *   'ws-message'  (connId, frame)  - a websocket frame in either direction
 *   'ws-close'    (connId)         - a websocket connection closed
 *   'intercept'   (flow)           - a request/response is held for the user
 *   'status'      (state)          - engine running state changed
 *   'error'       (message)        - a non-fatal engine error
 */
class ProxyEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8080;
    this.caDir = options.caDir || path.join(os.homedir(), '.proxyaudit');
    this.proxy = null;
    this.running = false;
    this._seq = 0;
    this._wsSeq = 0;

    // Interception state
    this.intercept = { enabled: false };
    // Pending held contexts awaiting a user decision, keyed by flow id.
    this._pending = new Map();

    // Match & Replace rules engine (shared with the main process when injected).
    this.matchreplace =
      options.matchreplace || new MatchReplace({ dir: this.caDir });
  }

  _nextId() {
    this._seq += 1;
    return `f${Date.now().toString(36)}-${this._seq}`;
  }

  caPath() {
    return path.join(this.caDir, 'certs', 'ca.pem');
  }

  async start() {
    if (this.running) return;
    fs.mkdirSync(this.caDir, { recursive: true });

    // If the chosen port is taken (e.g. another proxy like Burp on 8080),
    // move to the next free port instead of silently failing — otherwise the
    // launched browser would route to that other proxy and we'd capture
    // nothing.
    const requested = this.port;
    const free = await findFreePort(requested);
    if (free !== requested) {
      this.port = free;
      this.emit('error', `Port ${requested} is in use — ProxyAudit is now on ${free}.`);
    }

    this.proxy = new Proxy();
    this._wire();

    await new Promise((resolve, reject) => {
      this.proxy.listen(
        { port: this.port, host: '127.0.0.1', sslCaDir: this.caDir },
        (err) => {
          if (err) {
            this.emit('error', `Failed to start proxy: ${err.message}`);
            return reject(err);
          }
          this.running = true;
          this.emit('status', this.state());
          resolve();
        }
      );
    });
  }

  stop() {
    if (!this.proxy) return Promise.resolve();
    try {
      this.proxy.close();
    } catch (_) {
      /* ignore */
    }
    this.proxy = null;
    this.running = false;
    // Release anything still held so sockets don't hang forever.
    for (const [, held] of this._pending) {
      try {
        held.release('drop');
      } catch (_) {
        /* ignore */
      }
    }
    this._pending.clear();
    this.emit('status', this.state());
    return Promise.resolve();
  }

  state() {
    return {
      running: this.running,
      port: this.port,
      caPath: this.caPath(),
      intercept: this.intercept.enabled,
    };
  }

  setIntercept(enabled) {
    this.intercept.enabled = !!enabled;
    // If we're turning intercept off, auto-forward anything currently held.
    if (!this.intercept.enabled) {
      for (const [, held] of this._pending) {
        try {
          held.release('forward');
        } catch (_) {
          /* ignore */
        }
      }
      this._pending.clear();
    }
    this.emit('status', this.state());
  }

  /**
   * Resolve an intercepted flow. `decision` is 'forward' or 'drop'.
   * `edited` optionally carries replacement request fields from the UI.
   */
  resolveIntercept(flowId, decision, edited) {
    const held = this._pending.get(flowId);
    if (!held) return false;
    this._pending.delete(flowId);
    held.release(decision, edited);
    return true;
  }

  _wire() {
    const proxy = this.proxy;

    proxy.onError((ctx, err, errorKind) => {
      const url =
        ctx && ctx.clientToProxyRequest
          ? ctx.clientToProxyRequest.url
          : '';
      this.emit('error', `${errorKind || 'proxy'}: ${err.message} ${url}`);
    });

    proxy.onRequest((ctx, callback) => {
      try {
        this._onRequest(ctx, callback);
      } catch (e) {
        this.emit('error', `onRequest: ${e.message}`);
        callback();
      }
    });

    proxy.onWebSocketConnection((ctx, callback) => {
      this._onWsOpen(ctx);
      return callback();
    });

    proxy.onWebSocketSend((ctx, message, flags, callback) => {
      this._onWsFrame(ctx, 'outgoing', message, flags);
      return callback(null, message, flags);
    });

    proxy.onWebSocketMessage((ctx, message, flags, callback) => {
      this._onWsFrame(ctx, 'incoming', message, flags);
      return callback(null, message, flags);
    });

    proxy.onWebSocketClose((ctx, code, message, callback) => {
      if (ctx.__wsConnId) this.emit('ws-close', ctx.__wsConnId);
      return callback(code, message);
    });
  }

  _onRequest(ctx, callback) {
    const creq = ctx.clientToProxyRequest;
    const isSSL = ctx.isSSL;
    const host = creq.headers.host || ctx.proxyToServerRequestOptions?.host || '';
    const scheme = isSSL ? 'https' : 'http';
    const fullUrl = `${scheme}://${host}${creq.url}`;

    const flow = {
      id: this._nextId(),
      ts: Date.now(),
      scheme,
      method: creq.method,
      host,
      url: fullUrl,
      path: creq.url,
      httpVersion: creq.httpVersion,
      request: {
        headers: { ...creq.headers },
        body: null,
        bodyTruncated: false,
      },
      response: null,
      durationMs: null,
    };

    // --- Match & Replace (request) ---------------------------------------
    // Rewrites the request line + headers BEFORE the flow is recorded and
    // before callback() forwards upstream, so both the recorded flow and the
    // real upstream request carry the replacements. Request-body rewriting is
    // intentionally left to the Repeater (the body is streamed, not buffered).
    try {
      if (this.matchreplace) {
        const applied = this.matchreplace.applyRequest({
          method: creq.method,
          url: creq.url,
          headers: creq.headers,
          body: null,
        });
        creq.method = applied.method;
        creq.url = applied.url;
        creq.headers = applied.headers;
        flow.method = applied.method;
        flow.path = applied.url;
        flow.url = `${scheme}://${host}${applied.url}`;
        flow.request.headers = { ...applied.headers };
      }
    } catch (e) {
      this.emit('error', `matchreplace request: ${e.message}`);
    }

    // Capture request body.
    const reqChunks = [];
    let reqLen = 0;
    ctx.onRequestData((c, chunk, cb) => {
      if (reqLen < MAX_BODY_CAPTURE) {
        reqChunks.push(chunk);
        reqLen += chunk.length;
      } else {
        flow.request.bodyTruncated = true;
      }
      return cb(null, chunk);
    });
    ctx.onRequestEnd((c, cb) => {
      flow.request.body = Buffer.concat(reqChunks).toString('utf8');
      return cb();
    });

    // Capture response, decompressing gzip/deflate/br for display.
    const resChunks = [];
    let resLen = 0;
    ctx.use(Proxy.gunzip);
    ctx.onResponse((c, cb) => {
      const sres = c.serverToProxyResponse;
      flow.response = {
        status: sres.statusCode,
        statusMessage: sres.statusMessage,
        headers: { ...sres.headers },
        body: null,
        bodyTruncated: false,
        mime: (sres.headers['content-type'] || '').split(';')[0].trim(),
      };
      return cb();
    });
    ctx.onResponseData((c, chunk, cb) => {
      if (resLen < MAX_BODY_CAPTURE) {
        resChunks.push(chunk);
        resLen += chunk.length;
      } else if (flow.response) {
        flow.response.bodyTruncated = true;
      }
      return cb(null, chunk);
    });
    ctx.onResponseEnd((c, cb) => {
      if (flow.response) {
        flow.response.body = Buffer.concat(resChunks).toString('utf8');
        flow.response.length = resLen;
        // --- Match & Replace (response) ----------------------------------
        // Note: the body was already streamed to the client chunk-by-chunk,
        // so response rewrites affect the RECORDED/DISPLAYED response (history,
        // Repeater source, audits) — not the bytes the browser received.
        try {
          if (this.matchreplace) {
            const applied = this.matchreplace.applyResponse({
              status: flow.response.status,
              headers: flow.response.headers,
              body: flow.response.body,
            });
            flow.response.status = applied.status;
            flow.response.headers = applied.headers;
            flow.response.body = applied.body;
          }
        } catch (e) {
          this.emit('error', `matchreplace response: ${e.message}`);
        }
        flow.durationMs = Date.now() - flow.ts;
        this.emit('flow-update', flow);
      }
      return cb();
    });

    // Announce the flow as soon as headers are known.
    this.emit('flow', flow);

    // Interception: hold the request until the user decides.
    if (this.intercept.enabled) {
      const held = {
        flow,
        release: (decision, edited) => {
          if (decision === 'drop') {
            // End the client connection without forwarding.
            try {
              ctx.proxyToClientResponse.writeHead(502);
              ctx.proxyToClientResponse.end('Dropped by ProxyAudit');
            } catch (_) {
              /* ignore */
            }
            return;
          }
          if (edited) this._applyEdit(ctx, flow, edited);
          callback();
        },
      };
      this._pending.set(flow.id, held);
      flow.intercepted = true;
      this.emit('intercept', flow);
      return; // do not call callback() yet
    }

    return callback();
  }

  _applyEdit(ctx, flow, edited) {
    // Applied before callback() forwards the held request upstream, so these
    // mutations are picked up when the proxy builds the server request.
    // Request line and headers edit reliably here; body rewriting of an
    // in-flight streamed request is intentionally left to the Repeater, where
    // it is robust.
    const creq = ctx.clientToProxyRequest;
    if (edited.method) creq.method = edited.method;
    if (edited.path) {
      creq.url = edited.path;
      flow.path = edited.path;
    }
    if (edited.headers) {
      creq.headers = { ...edited.headers };
      flow.request.headers = { ...edited.headers };
    }
  }

  _onWsOpen(ctx) {
    this._wsSeq += 1;
    const connId = `w${Date.now().toString(36)}-${this._wsSeq}`;
    ctx.__wsConnId = connId;
    const creq = ctx.clientToProxyWebSocketRequest;
    const host = creq.headers.host || '';
    const scheme = ctx.isSSL ? 'wss' : 'ws';
    this.emit('ws-open', {
      id: connId,
      ts: Date.now(),
      url: `${scheme}://${host}${creq.url}`,
      host,
      headers: { ...creq.headers },
    });
  }

  _onWsFrame(ctx, direction, message, flags) {
    if (!ctx.__wsConnId) return;
    const isBinary = flags && flags.binary;
    this.emit('ws-message', ctx.__wsConnId, {
      ts: Date.now(),
      direction, // 'outgoing' = client->server, 'incoming' = server->client
      binary: !!isBinary,
      length: message.length,
      data: isBinary
        ? message.toString('base64')
        : message.toString('utf8'),
    });
  }
}

module.exports = { ProxyEngine };
