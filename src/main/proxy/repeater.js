'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

/**
 * Send a single HTTP request and resolve with the full response.
 * Used by the Repeater tab. TLS verification is intentionally relaxed so the
 * tester can hit hosts with self-signed or otherwise invalid certificates,
 * which is normal in a security-testing workflow.
 *
 * spec = { method, url, headers:{}, body:string, timeoutMs }
 */
function sendRequest(spec) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(spec.url);
    } catch (e) {
      return resolve({ error: `Invalid URL: ${spec.url}` });
    }

    const isHttps = target.protocol === 'https:';
    const lib = isHttps ? https : http;
    const started = Date.now();

    // Normalize headers: drop a stale Host and Content-Length carried over from
    // a captured request (they're wrong once the URL or body is edited). Node
    // sets Host from the URL; we always recompute Content-Length for a body.
    const headers = {};
    for (const [k, v] of Object.entries(spec.headers || {})) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'content-length') continue;
      headers[k] = v;
    }
    const bodyBuf =
      spec.body != null ? Buffer.from(String(spec.body), 'utf8') : null;
    if (bodyBuf) headers['Content-Length'] = String(bodyBuf.length);

    const options = {
      method: spec.method || 'GET',
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      headers,
      rejectUnauthorized: false,
      servername: target.hostname,
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') raw = zlib.gunzipSync(raw);
          else if (enc === 'deflate') raw = zlib.inflateSync(raw);
          else if (enc === 'br') raw = zlib.brotliDecompressSync(raw);
        } catch (_) {
          /* leave raw as-is if decompression fails */
        }
        resolve({
          status: res.statusCode,
          statusMessage: res.statusMessage,
          headers: res.headers,
          body: raw.toString('utf8'),
          length: raw.length,
          durationMs: Date.now() - started,
          mime: (res.headers['content-type'] || '').split(';')[0].trim(),
        });
      });
    });

    req.on('error', (err) =>
      resolve({ error: err.message, durationMs: Date.now() - started })
    );
    req.setTimeout(spec.timeoutMs || 30000, () => {
      req.destroy();
      resolve({ error: 'Request timed out', durationMs: Date.now() - started });
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

module.exports = { sendRequest };
