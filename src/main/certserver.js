'use strict';

const http = require('http');
const fs = require('fs');

/**
 * A tiny, standalone HTTP server that serves the ProxyAudit CA certificate on
 * the LAN — independent of the MITM proxy. This solves the chicken-and-egg
 * problem of mobile setup: you need the CA to intercept HTTPS, but fetching it
 * through the proxy requires the proxy to already work. With this, a phone just
 * browses to http://<your-ip>:<certPort>/ directly and installs the cert, no
 * proxy required.
 *
 *   start(host) -> Promise<{ port }>   (auto-bumps if the port is busy)
 *   stop()
 */
class CertServer {
  constructor(opts = {}) {
    this.caPathFn = opts.caPath; // () => path to ca.pem
    this.basePort = opts.port || 8099;
    this.server = null;
    this.port = null;
  }

  der() {
    const pem = fs.readFileSync(this.caPathFn(), 'utf8');
    const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
    if (!m) throw new Error('CA certificate not found');
    return Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  }

  _handler(req, res) {
    const urlPath = String(req.url || '/').split('?')[0];
    if (/^\/(cert|ca|ca\.crt|ca\.pem|proxyaudit\.crt|proxyaudit-ca\.crt)$/i.test(urlPath)) {
      try {
        const der = this.der();
        res.writeHead(200, {
          'Content-Type': 'application/x-x509-ca-cert',
          'Content-Disposition': 'attachment; filename="proxyaudit-ca.crt"',
          'Content-Length': der.length,
          Connection: 'close',
        });
        res.end(der);
      } catch (e) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('CA not available yet — start the proxy once, then retry. (' + e.message + ')');
      }
      return;
    }
    const body =
      '<!doctype html><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>ProxyAudit — install CA</title>' +
      '<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;color:#111}' +
      'h1{font-size:20px}a.btn{display:inline-block;margin:14px 0;padding:12px 18px;background:#c96a16;color:#fff;' +
      'border-radius:10px;text-decoration:none;font-weight:600}code{background:#eee;padding:1px 5px;border-radius:4px}</style>' +
      '<h1>ProxyAudit CA certificate</h1>' +
      '<p>Install this certificate to intercept HTTPS from this device.</p>' +
      '<p><a class="btn" href="/cert">⬇ Download CA certificate</a></p>' +
      '<p><b>iOS:</b> install the profile, then <b>Settings → General → VPN &amp; Device Management</b> to install it, ' +
      'then <b>Settings → General → About → Certificate Trust Settings</b> and turn it <b>ON</b>.</p>' +
      '<p><b>Android:</b> Settings → Security → <b>Encryption &amp; credentials → Install a certificate → CA certificate</b>.</p>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
    res.end(body);
  }

  start(host = '0.0.0.0') {
    if (this.server) return Promise.resolve({ port: this.port });
    return new Promise((resolve, reject) => {
      let attempt = 0;
      const tryListen = (port) => {
        const srv = http.createServer((req, res) => this._handler(req, res));
        srv.on('error', (err) => {
          if (err.code === 'EADDRINUSE' && attempt < 20) { attempt += 1; tryListen(port + 1); }
          else reject(err);
        });
        srv.listen(port, host, () => {
          this.server = srv;
          this.port = port;
          resolve({ port });
        });
      };
      tryListen(this.basePort);
    });
  }

  stop() {
    if (this.server) { try { this.server.close(); } catch (_) {} this.server = null; this.port = null; }
    return Promise.resolve();
  }
}

module.exports = { CertServer };
