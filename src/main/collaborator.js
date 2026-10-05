'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn, execSync } = require('child_process');

/**
 * Burp-Collaborator-style out-of-band interaction logger.
 *
 * Starts a local HTTP server and exposes it publicly through a `cloudflared`
 * quick tunnel (https://<random>.trycloudflare.com). Any HTTP(S) request that
 * reaches a generated payload URL — e.g. from a blind SSRF, blind XSS beacon,
 * XXE, or webhook — is captured and surfaced in the Collaborator tab.
 *
 * Note: Cloudflare quick tunnels expose HTTP only (no per-payload DNS or SMTP),
 * so this captures HTTP callbacks, which covers the large majority of OOB
 * testing. Each payload id is the first path segment of its URL.
 *
 * Events: 'interaction' (record), 'status' (state), 'error' (message)
 */
class Collaborator extends EventEmitter {
  constructor() {
    super();
    this.server = null;
    this.tunnel = null; // cloudflared child process
    this.publicUrl = null;
    this.port = null;
    this.running = false;
    this.starting = false;
    this.interactions = [];
    this.payloads = []; // generated ids
    this._seq = 0;
  }

  static findCloudflared() {
    const candidates = [
      '/opt/homebrew/bin/cloudflared',
      '/usr/local/bin/cloudflared',
      '/usr/bin/cloudflared',
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    try {
      const p = execSync('command -v cloudflared', { encoding: 'utf8' }).trim();
      if (p) return p;
    } catch (_) {
      /* not on PATH */
    }
    return null;
  }

  state() {
    return {
      running: this.running,
      starting: this.starting,
      publicUrl: this.publicUrl,
      port: this.port,
      cloudflared: !!Collaborator.findCloudflared(),
      interactions: this.interactions.length,
    };
  }

  async start() {
    if (this.running || this.starting) return this.state();
    const bin = Collaborator.findCloudflared();
    if (!bin) {
      const msg =
        'cloudflared not found. Install it with `brew install cloudflared`, then try again.';
      this.emit('error', msg);
      return { ...this.state(), error: msg };
    }
    this.starting = true;
    this.emit('status', this.state());

    await this._startServer();
    try {
      await this._startTunnel(bin);
    } catch (e) {
      this.starting = false;
      this._stopServer();
      this.emit('error', 'Tunnel failed: ' + e.message);
      return { ...this.state(), error: e.message };
    }
    this.running = true;
    this.starting = false;
    this.emit('status', this.state());
    return this.state();
  }

  _startServer() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._onHit(req, res));
      this.server.on('error', (e) => this.emit('error', 'Collaborator server: ' + e.message));
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  _startTunnel(bin) {
    return new Promise((resolve, reject) => {
      this.tunnel = spawn(bin, [
        'tunnel',
        '--no-autoupdate',
        '--url',
        `http://127.0.0.1:${this.port}`,
      ]);
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('timed out waiting for tunnel URL'));
        }
      }, 25000);

      const scan = (buf) => {
        const s = buf.toString();
        const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && !settled) {
          settled = true;
          clearTimeout(timer);
          this.publicUrl = m[0];
          resolve();
        }
      };
      this.tunnel.stdout.on('data', scan);
      this.tunnel.stderr.on('data', scan); // cloudflared logs the URL to stderr
      this.tunnel.on('error', (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(e);
        }
      });
      this.tunnel.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('cloudflared exited (code ' + code + ')'));
        }
        if (this.running) {
          this.running = false;
          this.publicUrl = null;
          this.emit('status', this.state());
        }
      });
    });
  }

  _onHit(req, res) {
    const chunks = [];
    req.on('data', (c) => chunks.length < 2000 && chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8').slice(0, 65536);
      const firstSeg = (req.url.split('?')[0].split('/')[1] || '').trim();
      const matched = this.payloads.find((id) => req.url.includes(id)) || firstSeg || null;
      this._seq += 1;
      const record = {
        id: this._seq,
        ts: Date.now(),
        payload: matched,
        protocol: 'http',
        method: req.method,
        url: req.url,
        httpVersion: req.httpVersion,
        headers: { ...req.headers },
        body,
        remote: req.socket.remoteAddress,
      };
      this.interactions.push(record);
      if (this.interactions.length > 5000) this.interactions.shift();
      this.emit('interaction', record);

      // Respond so the caller gets a clean 200 (and a tiny beacon pixel path works).
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok\n');
    });
  }

  generatePayload() {
    if (!this.publicUrl) return { error: 'Tunnel not running' };
    const id = crypto.randomBytes(5).toString('hex');
    this.payloads.push(id);
    return {
      id,
      httpUrl: `${this.publicUrl}/${id}`,
      host: this.publicUrl.replace(/^https?:\/\//, ''),
    };
  }

  getInteraction(id) {
    return this.interactions.find((i) => i.id === id) || null;
  }
  list() {
    return this.interactions.map((i) => ({
      id: i.id,
      ts: i.ts,
      payload: i.payload,
      method: i.method,
      url: i.url,
      remote: i.remote,
    }));
  }

  _stopServer() {
    if (this.server) {
      try { this.server.close(); } catch (_) {}
      this.server = null;
    }
  }

  stop() {
    if (this.tunnel) {
      try { this.tunnel.kill(); } catch (_) {}
      this.tunnel = null;
    }
    this._stopServer();
    this.running = false;
    this.starting = false;
    this.publicUrl = null;
    this.emit('status', this.state());
    return this.state();
  }
}

module.exports = { Collaborator };
