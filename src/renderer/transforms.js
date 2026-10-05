'use strict';

/*
 * transforms.js — pure, browser-safe encode/decode transforms for the Decoder tab.
 *
 * No Node APIs. Uses only atob/btoa, TextEncoder/TextDecoder, encodeURIComponent,
 * and (where available) DecompressionStream/CompressionStream.
 *
 * Exposes window.Transforms:
 *   - Transforms.list          -> [{ id, label, group }]  (for building the dropdown)
 *   - Transforms.get(id)       -> { id, label, group, fn }
 *   - Transforms.apply(id,str) -> Promise<string>  (always async-safe; throws on bad input)
 *
 * Each transform fn takes a string and returns a string or a Promise<string>.
 * On invalid input a transform throws an Error with a human-readable message.
 */
(function () {
  // ----------------------------- byte helpers -----------------------------
  // A "binary string" here means one char per byte (0..255), the form atob/btoa use.
  function strToBytes(str) {
    // Treat each code unit as a byte (latin1). Used for binary-ish inputs.
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }
  function bytesToBinaryStr(bytes) {
    let s = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return s;
  }
  function utf8Encode(str) {
    return new TextEncoder().encode(str);
  }
  function utf8Decode(bytes) {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }

  // ----------------------------- Base64 -----------------------------
  function base64Encode(str) {
    // UTF-8 aware: text -> bytes -> base64.
    return btoa(bytesToBinaryStr(utf8Encode(str)));
  }
  function base64Decode(str) {
    const cleaned = str.replace(/\s+/g, '');
    let bin;
    try {
      bin = atob(cleaned);
    } catch (e) {
      throw new Error('Not valid Base64');
    }
    return utf8Decode(strToBytes(bin));
  }
  function base64UrlDecodeToBytes(str) {
    let s = str.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
    while (s.length % 4) s += '=';
    return strToBytes(atob(s));
  }

  // ----------------------------- URL (percent) -----------------------------
  function urlEncode(str) {
    return encodeURIComponent(str);
  }
  function urlDecode(str) {
    try {
      // Also turn '+' into space, matching application/x-www-form-urlencoded.
      return decodeURIComponent(str.replace(/\+/g, ' '));
    } catch (e) {
      throw new Error('Malformed percent-encoding');
    }
  }

  // ----------------------------- HTML entities -----------------------------
  const HTML_NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    copy: '©', reg: '®', trade: '™', hellip: '…',
    mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', euro: '€', pound: '£',
    cent: '¢', deg: '°', plusmn: '±', times: '×',
    divide: '÷', frac12: '½', frac14: '¼', frac34: '¾',
  };
  function htmlEncode(str) {
    return str.replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function htmlDecode(str) {
    return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (m, body) {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!isFinite(code)) return m;
        try {
          return String.fromCodePoint(code);
        } catch (e) {
          return m;
        }
      }
      return Object.prototype.hasOwnProperty.call(HTML_NAMED, body) ? HTML_NAMED[body] : m;
    });
  }

  // ----------------------------- Hex -----------------------------
  function hexEncode(str) {
    const bytes = utf8Encode(str);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i].toString(16).padStart(2, '0');
    }
    return out;
  }
  function hexDecode(str) {
    const cleaned = str.replace(/0x/gi, '').replace(/[\s:,-]+/g, '');
    if (cleaned.length === 0) return '';
    if (!/^[0-9a-fA-F]+$/.test(cleaned)) throw new Error('Not valid hex');
    if (cleaned.length % 2 !== 0) throw new Error('Hex length must be even');
    const bytes = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(cleaned.substr(i * 2, 2), 16);
    }
    return utf8Decode(bytes);
  }

  // ----------------------------- ASCII / Char codes -----------------------------
  function asciiEncode(str) {
    // Space-separated decimal code points.
    return Array.from(str).map(function (ch) { return ch.codePointAt(0); }).join(' ');
  }
  function asciiDecode(str) {
    const parts = str.trim().split(/[\s,]+/).filter(Boolean);
    let out = '';
    for (const p of parts) {
      const code = /^0x/i.test(p) ? parseInt(p, 16) : parseInt(p, 10);
      if (!isFinite(code)) throw new Error('Invalid char code: ' + p);
      out += String.fromCodePoint(code);
    }
    return out;
  }

  // ----------------------------- Gzip -----------------------------
  async function streamTransform(bytes, stream) {
    const blob = new Response(new Blob([bytes]).stream().pipeThrough(stream));
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf);
  }
  async function gzipDecode(str) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('Gzip decode needs DecompressionStream (not available in this runtime)');
    }
    // Input is treated as raw bytes (one char per byte). Pair with Base64-decode
    // first if your data is Base64 text.
    const bytes = strToBytes(str);
    const out = await streamTransform(bytes, new DecompressionStream('gzip'));
    return utf8Decode(out);
  }
  async function gzipEncode(str) {
    if (typeof CompressionStream === 'undefined') {
      throw new Error('Gzip encode needs CompressionStream (not available in this runtime)');
    }
    const out = await streamTransform(utf8Encode(str), new CompressionStream('gzip'));
    // Return as a binary string so it can be chained into Base64-encode.
    return bytesToBinaryStr(out);
  }

  // ----------------------------- JWT -----------------------------
  function jwtDecode(str) {
    const token = str.trim();
    const parts = token.split('.');
    if (parts.length < 2) throw new Error('Not a JWT (expected header.payload.signature)');
    function decodePart(p, name) {
      let text;
      try {
        text = utf8Decode(base64UrlDecodeToBytes(p));
      } catch (e) {
        throw new Error('JWT ' + name + ' is not valid base64url');
      }
      try {
        return JSON.stringify(JSON.parse(text), null, 2);
      } catch (e) {
        return text; // not JSON, show raw
      }
    }
    const header = decodePart(parts[0], 'header');
    const payload = decodePart(parts[1], 'payload');
    const sig = parts[2] || '';
    return (
      '// Header\n' + header +
      '\n\n// Payload\n' + payload +
      '\n\n// Signature (not verified)\n' + sig
    );
  }

  // ----------------------------- Smart decode -----------------------------
  function looksLikeJwt(s) {
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(s.trim());
  }
  function looksLikeHex(s) {
    const c = s.replace(/[\s:,-]+/g, '');
    return c.length >= 2 && c.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(c);
  }
  function looksLikePercent(s) {
    return /%[0-9a-fA-F]{2}/.test(s);
  }
  function looksLikeBase64(s) {
    const c = s.replace(/\s+/g, '');
    return c.length >= 4 && c.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(c);
  }
  function looksLikeHtmlEntities(s) {
    return /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/.test(s);
  }
  function isMostlyPrintable(s) {
    if (!s.length) return false;
    let bad = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 9 || c === 10 || c === 13) continue;
      if (c < 32 || c === 0xfffd) bad++;
    }
    return bad / s.length < 0.1;
  }
  function smartDecode(str) {
    const s = str.trim();
    if (!s) return '';
    const tries = [];
    if (looksLikeJwt(s)) tries.push(['JWT', function () { return jwtDecode(s); }]);
    if (looksLikePercent(s)) tries.push(['URL', function () { return urlDecode(s); }]);
    if (looksLikeHtmlEntities(s)) tries.push(['HTML', function () { return htmlDecode(s); }]);
    if (looksLikeBase64(s)) tries.push(['Base64', function () { return base64Decode(s); }]);
    if (looksLikeHex(s)) tries.push(['Hex', function () { return hexDecode(s); }]);
    for (const [name, fn] of tries) {
      try {
        const out = fn();
        if (out && out !== s && (name === 'JWT' || isMostlyPrintable(out))) {
          return '// Smart decode detected: ' + name + '\n' + out;
        }
      } catch (e) {
        /* try next strategy */
      }
    }
    return '// Smart decode: no confident decoding found; input unchanged\n' + str;
  }

  // ----------------------------- registry -----------------------------
  const TRANSFORMS = [
    { id: 'smart', label: 'Smart decode', group: 'Smart', fn: smartDecode },

    { id: 'b64enc', label: 'Base64 encode', group: 'Base64', fn: base64Encode },
    { id: 'b64dec', label: 'Base64 decode', group: 'Base64', fn: base64Decode },

    { id: 'urlenc', label: 'URL encode', group: 'URL', fn: urlEncode },
    { id: 'urldec', label: 'URL decode', group: 'URL', fn: urlDecode },

    { id: 'htmlenc', label: 'HTML entities encode', group: 'HTML', fn: htmlEncode },
    { id: 'htmldec', label: 'HTML entities decode', group: 'HTML', fn: htmlDecode },

    { id: 'hexenc', label: 'Hex encode', group: 'Hex', fn: hexEncode },
    { id: 'hexdec', label: 'Hex decode', group: 'Hex', fn: hexDecode },

    { id: 'asciienc', label: 'ASCII/Char encode', group: 'ASCII', fn: asciiEncode },
    { id: 'asciidec', label: 'ASCII/Char decode', group: 'ASCII', fn: asciiDecode },

    { id: 'gzipdec', label: 'Gzip decode', group: 'Gzip', fn: gzipDecode },
    { id: 'gzipenc', label: 'Gzip encode', group: 'Gzip', fn: gzipEncode },

    { id: 'jwtdec', label: 'JWT decode', group: 'JWT', fn: jwtDecode },
  ];

  const BY_ID = {};
  TRANSFORMS.forEach(function (t) { BY_ID[t.id] = t; });

  window.Transforms = {
    list: TRANSFORMS.map(function (t) {
      return { id: t.id, label: t.label, group: t.group };
    }),
    get: function (id) { return BY_ID[id] || null; },
    // Always returns a Promise<string>; rejects with an Error on bad input.
    apply: function (id, input) {
      const t = BY_ID[id];
      if (!t) return Promise.reject(new Error('Unknown transform: ' + id));
      return Promise.resolve().then(function () { return t.fn(String(input == null ? '' : input)); });
    },
  };
})();
