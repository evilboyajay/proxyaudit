'use strict';

const zlib = require('zlib');

// Lenient flush modes so a truncated body (capture cap hit) still yields
// whatever plaintext was decodable instead of throwing.
const Z_OPTS = { finishFlush: zlib.constants.Z_SYNC_FLUSH };
const BR_OPTS = { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH };

function decodeOne(buf, enc) {
  switch (enc) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(buf, Z_OPTS);
    case 'deflate':
      // Servers disagree on zlib-wrapped vs raw deflate; accept both.
      try {
        return zlib.inflateSync(buf, Z_OPTS);
      } catch (_) {
        return zlib.inflateRawSync(buf, Z_OPTS);
      }
    case 'br':
      return zlib.brotliDecompressSync(buf, BR_OPTS);
    case 'zstd':
      if (typeof zlib.zstdDecompressSync === 'function') {
        return zlib.zstdDecompressSync(buf);
      }
      throw new Error('zstd not supported by this runtime');
    case '':
    case 'identity':
      return buf;
    default:
      throw new Error(`unsupported content-encoding: ${enc}`);
  }
}

/**
 * Decode an HTTP body according to its Content-Encoding header value.
 * Multiple codings ("gzip, br") are listed in the order applied, so they are
 * undone in reverse. Returns { body, decoded, encoding, error }; on failure
 * `body` is the original buffer.
 */
function decodeBody(buf, contentEncoding) {
  const encoding = String(contentEncoding || '').trim().toLowerCase();
  const codings = encoding
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== 'identity');
  if (!buf || !buf.length || !codings.length) {
    return { body: buf, decoded: false, encoding, error: null };
  }
  try {
    let out = buf;
    for (let i = codings.length - 1; i >= 0; i--) out = decodeOne(out, codings[i]);
    return { body: out, decoded: true, encoding, error: null };
  } catch (e) {
    return { body: buf, decoded: false, encoding, error: e.message };
  }
}

module.exports = { decodeBody };
