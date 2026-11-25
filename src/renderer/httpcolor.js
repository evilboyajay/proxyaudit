'use strict';

/*
 * HttpColor — Burp-style syntax colouring for raw HTTP messages.
 *
 * Browser-safe (no Node APIs). Attaches window.HttpColor.
 *
 *   const toks = HttpColor.tokenize(text);          // [{ t, c }]
 *   const lines = HttpColor.toLines(toks, hits, i); // HTML string per line
 *
 * The concatenated token text is ALWAYS exactly the input text (with CRLF
 * normalised to LF), so the coloured output can overlay a textarea or be
 * searched by character offset. Colours follow Burp's light theme:
 * header / cookie / parameter names and HTML tag names in blue, their values
 * and HTML attribute names in red, attribute values in blue.
 *
 * Token classes (styled in styles.css):
 *   tk-method tk-path tk-ver tk-status tk-reason   start line
 *   tk-hname tk-punct                              header name and ':'
 *   tk-pname tk-pval                               cookie / query / form params
 *   tk-key tk-str tk-num tk-bool tk-null           JSON
 *   tk-tag tk-attr tk-aval tk-doctype tk-comment   HTML / XML
 *   tk-pos                                         Intruder §payload§ marker
 */
(function () {
  const COLOR_LIMIT = 1024 * 1024; // past this, emit plain text (keeps huge bodies snappy)

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---------------------------- pieces -----------------------------
  function push(out, t, c) {
    if (!t) return;
    const last = out[out.length - 1];
    if (last && last.c === c) last.t += t;
    else out.push({ t, c: c || '' });
  }

  // name=value&name=value (query strings, form bodies, cookie pairs).
  function params(out, s, sep) {
    const re = sep === ';' ? /(;\s*)/ : /(&)/;
    const parts = s.split(re);
    for (const part of parts) {
      if (!part) continue;
      if (/^(;\s*|&)$/.test(part)) {
        push(out, part, 'tk-punct');
        continue;
      }
      const eq = part.indexOf('=');
      if (eq < 0) {
        push(out, part, 'tk-pname');
        continue;
      }
      push(out, part.slice(0, eq), 'tk-pname');
      push(out, '=', 'tk-punct');
      push(out, part.slice(eq + 1), 'tk-pval');
    }
  }

  function startLine(out, line) {
    let m = /^(HTTP\/[\d.]+|HTTP)(\s+)(\d{3})(\s*)(.*)$/.exec(line);
    if (m) {
      push(out, m[1], 'tk-ver');
      push(out, m[2]);
      push(out, m[3], 'tk-status');
      push(out, m[4]);
      push(out, m[5], 'tk-reason');
      return true;
    }
    m = /^([A-Z][A-Z-]{1,15})(\s+)(\S+)(\s*)(HTTP\/[\d.]+)?(.*)$/.exec(line);
    if (m && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT|[A-Z-]+)$/.test(m[1]) && (m[5] || /^(\/|https?:|\*)/.test(m[3]))) {
      push(out, m[1], 'tk-method');
      push(out, m[2]);
      const target = m[3];
      const q = target.indexOf('?');
      if (q >= 0) {
        push(out, target.slice(0, q), 'tk-path');
        push(out, '?', 'tk-punct');
        params(out, target.slice(q + 1), '&');
      } else {
        push(out, target, 'tk-path');
      }
      push(out, m[4]);
      push(out, m[5] || '', 'tk-ver');
      push(out, m[6]);
      return true;
    }
    return false;
  }

  function headerLine(out, line) {
    const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(:)(\s*)(.*)$/.exec(line);
    if (!m) {
      push(out, line);
      return;
    }
    push(out, m[1], 'tk-hname');
    push(out, m[2], 'tk-punct');
    push(out, m[3]);
    const name = m[1].toLowerCase();
    const val = m[4];
    if (name === 'cookie') {
      params(out, val, ';');
    } else if (name === 'set-cookie') {
      // First pair is the cookie; the attributes after it stay plain (as Burp).
      const semi = val.indexOf(';');
      const pair = semi < 0 ? val : val.slice(0, semi);
      params(out, pair, ';');
      if (semi >= 0) push(out, val.slice(semi));
    } else {
      push(out, val);
    }
  }

  // ------------------------------ JSON -----------------------------
  function json(out, s) {
    const re =
      /("(?:\\.|[^"\\\n])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false)\b|\b(null)\b|([{}\[\],:])/g;
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) push(out, s.slice(last, m.index));
      if (m[1] != null) {
        if (m[2] != null) {
          push(out, m[1], 'tk-key');
          push(out, m[2], 'tk-punct');
        } else push(out, m[1], 'tk-str');
      } else if (m[3] != null) push(out, m[3], 'tk-num');
      else if (m[4] != null) push(out, m[4], 'tk-bool');
      else if (m[5] != null) push(out, m[5], 'tk-null');
      else push(out, m[6], 'tk-punct');
      last = re.lastIndex;
    }
    if (last < s.length) push(out, s.slice(last));
  }

  // --------------------------- HTML / XML --------------------------
  function markup(out, s) {
    const re = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<\?[\s\S]*?(?:\?>|$)|<\/?[A-Za-z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>?/g;
    let last = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m.index > last) push(out, s.slice(last, m.index));
      const t = m[0];
      if (t.startsWith('<!--')) push(out, t, 'tk-comment');
      else if (t.startsWith('<!') || t.startsWith('<?')) push(out, t, 'tk-doctype');
      else tag(out, t);
      last = re.lastIndex;
    }
    if (last < s.length) push(out, s.slice(last));
  }
  function tag(out, t) {
    const head = /^<\/?[^\s/>]*/.exec(t)[0];
    push(out, head, 'tk-tag');
    let rest = t.slice(head.length);
    let close = '';
    const cm = /\s*\/?>$/.exec(rest);
    if (cm) {
      close = cm[0];
      rest = rest.slice(0, rest.length - close.length);
    }
    const are = /(\s+)([^\s=/>]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+))?/g;
    let last = 0;
    let m;
    while ((m = are.exec(rest)) !== null) {
      if (m.index > last) push(out, rest.slice(last, m.index));
      push(out, m[1]);
      push(out, m[2], 'tk-attr');
      if (m[3] != null) {
        push(out, m[3], 'tk-punct');
        push(out, m[4], 'tk-aval');
      }
      last = are.lastIndex;
    }
    if (last < rest.length) push(out, rest.slice(last));
    if (close) {
      const ws = /^\s*/.exec(close)[0];
      push(out, ws);
      push(out, close.slice(ws.length), 'tk-tag');
    }
  }

  // ------------------------------ body -----------------------------
  function contentType(headLines) {
    for (const l of headLines) {
      const m = /^content-type\s*:\s*(.*)$/i.exec(l);
      if (m) return m[1].toLowerCase();
    }
    return '';
  }
  function detectKind(ct, body) {
    const t = body.trimStart();
    if (/json/.test(ct) || /^[{[]/.test(t)) return 'json';
    if (/html|xml|svg/.test(ct) || /^<[!?A-Za-z]/.test(t)) return 'markup';
    if (/x-www-form-urlencoded/.test(ct)) return 'form';
    if (!ct && /^[\w.%\-\[\]]+=[^\s]*(&[\w.%\-\[\]]+=[^\s]*)*$/.test(t.trimEnd())) return 'form';
    return 'plain';
  }
  function bodyTokens(out, body, kind) {
    if (!body) return;
    if (kind === 'json') json(out, body);
    else if (kind === 'markup') markup(out, body);
    else if (kind === 'form') params(out, body, '&');
    else push(out, body);
  }

  // Intruder §payload§ markers win over any other colouring.
  function markPositions(tokens) {
    if (!tokens.some((x) => x.t.indexOf('§') >= 0)) return tokens;
    const text = tokens.map((x) => x.t).join('');
    const spans = [];
    const re = /§[^§\n]*§/g;
    let m;
    while ((m = re.exec(text)) !== null) spans.push([m.index, m.index + m[0].length]);
    if (!spans.length) return tokens;
    return overlay(tokens, spans, 'tk-pos');
  }
  // Re-cut tokens at span boundaries and replace their class inside spans.
  function overlay(tokens, spans, cls) {
    const out = [];
    let off = 0;
    let si = 0;
    for (const tok of tokens) {
      let s = tok.t;
      let start = off;
      off += s.length;
      while (s) {
        while (si < spans.length && spans[si][1] <= start) si++;
        const sp = spans[si];
        if (!sp || sp[0] >= start + s.length) {
          push(out, s, tok.c);
          break;
        }
        if (sp[0] > start) {
          const n = sp[0] - start;
          push(out, s.slice(0, n), tok.c);
          s = s.slice(n);
          start += n;
          continue;
        }
        const n = Math.min(sp[1] - start, s.length);
        push(out, s.slice(0, n), cls);
        s = s.slice(n);
        start += n;
      }
    }
    return out;
  }

  /**
   * Tokenise a raw HTTP message (start line optional — Repeater's editor
   * holds headers + body only). options.bodyKind forces the body grammar:
   * 'json' | 'markup' | 'form' | 'plain'.
   */
  function tokenize(text, options = {}) {
    const src = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    if (src.length > COLOR_LIMIT) return [{ t: src, c: '' }];
    const out = [];
    const split = src.indexOf('\n\n');
    let head = split >= 0 ? src.slice(0, split) : src;
    let body = split >= 0 ? src.slice(split + 2) : '';
    let sep = split >= 0 ? '\n\n' : '';
    const lines = head.split('\n');
    // No header block at all (e.g. a bare JSON body): colour as body.
    const looksHead =
      /^[A-Z-]+ \S+/.test(lines[0]) || /^HTTP\//.test(lines[0]) || /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:/.test(lines[0]);
    if (!looksHead) {
      bodyTokens(out, src, options.bodyKind || detectKind('', src));
      return markPositions(out);
    }
    lines.forEach((line, i) => {
      if (i > 0) push(out, '\n');
      if (i === 0 && startLine(out, line)) return;
      headerLine(out, line);
    });
    push(out, sep);
    bodyTokens(out, body, options.bodyKind || detectKind(contentType(lines), body));
    return markPositions(out);
  }

  /**
   * Turn tokens into one HTML string per line. Optional search hits
   * ([[start, end], ...] sorted, by character offset) are wrapped in
   * <mark class="ms-hit"> (current one also gets .ms-cur).
   */
  function toLines(tokens, hits, current) {
    const lines = [];
    let line = '';
    let off = 0;
    let h = 0;
    hits = hits || [];
    const emit = (s, c, hit) => {
      // s contains no newlines here
      if (!s) return;
      let html = c ? `<span class="${c}">${esc(s)}</span>` : esc(s);
      if (hit != null) html = `<mark class="ms-hit${hit === current ? ' ms-cur' : ''}" data-hit="${hit}">${html}</mark>`;
      line += html;
    };
    for (const tok of tokens) {
      let s = tok.t;
      while (s) {
        // next cut: newline, hit start or hit end
        while (h < hits.length && hits[h][1] <= off) h++;
        const nl = s.indexOf('\n');
        let cut = nl >= 0 ? nl : s.length;
        let inHit = null;
        if (h < hits.length) {
          const [a, b] = hits[h];
          if (a <= off) {
            inHit = h;
            cut = Math.min(cut, b - off);
          } else cut = Math.min(cut, a - off);
        }
        if (cut === 0 && nl === 0) {
          lines.push(line);
          line = '';
          s = s.slice(1);
          off += 1;
          continue;
        }
        emit(s.slice(0, cut), tok.c, inHit);
        s = s.slice(cut);
        off += cut;
      }
    }
    lines.push(line);
    return lines;
  }

  window.HttpColor = { tokenize, toLines, esc };
})();
