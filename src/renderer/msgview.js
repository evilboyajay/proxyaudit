'use strict';

/*
 * MsgView — a reusable HTTP message viewer with Pretty / Raw / Hex tabs.
 *
 * Browser-safe (no Node APIs). Attaches window.MsgView.
 *
 *   const ctl = MsgView.mount(containerEl);
 *   ctl.setMessage(rawHttpString);   // "METHOD path HTTP/1.1\n<headers>\n\n<body>"
 *   ctl.setMode('pretty' | 'raw' | 'hex');
 *   ctl.destroy();
 *
 * Also exported:
 *   MsgView.prettyJson(str)  -> highlighted HTML string (spans with .j-* classes)
 *   MsgView.looksJson(str)   -> boolean
 */
(function () {
  const MODES = ['pretty', 'raw', 'hex'];

  // --------------------------- helpers ----------------------------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Split a raw HTTP message into its start line, headers map and body.
  // Handles both LF and CRLF line endings; the body starts after the
  // first blank line.
  function parseMessage(raw) {
    const text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
    let idx = text.indexOf('\n\n');
    const headPart = idx >= 0 ? text.slice(0, idx) : text;
    const body = idx >= 0 ? text.slice(idx + 2) : '';
    const lines = headPart.split('\n');
    const startLine = lines.length ? lines[0] : '';
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const c = line.indexOf(':');
      if (c > 0) headers[line.slice(0, c).trim()] = line.slice(c + 1).trim();
    }
    return { startLine, headers, body, headPart };
  }

  function contentTypeOf(headers) {
    for (const k in headers) {
      if (k.toLowerCase() === 'content-type') return String(headers[k]).toLowerCase();
    }
    return '';
  }

  // --------------------------- JSON -------------------------------
  function looksJson(str) {
    if (str == null) return false;
    const t = String(str).trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return false;
    try {
      JSON.parse(t);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Syntax-highlight a JSON string into safe HTML. Re-stringifies with a
  // 2-space indent, then tokenises the (already HTML-escaped) output so
  // keys / strings / numbers / bool / null each get a token class.
  function prettyJson(str) {
    let obj;
    try {
      obj = JSON.parse(String(str));
    } catch (e) {
      return esc(String(str));
    }
    return highlightJsonValue(JSON.stringify(obj, null, 2));
  }

  // Tokenise a pretty-printed JSON text (produced by JSON.stringify) into
  // highlighted, escaped HTML. Strings are matched first so that braces or
  // digits inside a string literal are never mistaken for punctuation.
  function highlightJsonValue(jsonText) {
    const re =
      /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|(\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(\btrue\b|\bfalse\b)|(\bnull\b)|([{}\[\],:])/g;
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(jsonText)) !== null) {
      if (m.index > last) out += esc(jsonText.slice(last, m.index));
      if (m[1] != null) {
        // key: a quoted string immediately followed by a colon
        const key = m[1].replace(/\s*:$/, '');
        out += '<span class="j-key">' + esc(key) + '</span>';
        out += '<span class="j-punct">:</span>';
      } else if (m[2] != null) {
        out += '<span class="j-str">' + esc(m[2]) + '</span>';
      } else if (m[3] != null) {
        out += '<span class="j-num">' + esc(m[3]) + '</span>';
      } else if (m[4] != null) {
        out += '<span class="j-bool">' + esc(m[4]) + '</span>';
      } else if (m[5] != null) {
        out += '<span class="j-null">' + esc(m[5]) + '</span>';
      } else if (m[6] != null) {
        out += '<span class="j-punct">' + esc(m[6]) + '</span>';
      }
      last = re.lastIndex;
    }
    if (last < jsonText.length) out += esc(jsonText.slice(last));
    return out;
  }

  // --------------------------- GraphQL ----------------------------
  // Reflow a GraphQL query string with brace-based indentation. This is a
  // lightweight pretty-printer: it does not parse the grammar, it just
  // normalises whitespace and indents on { } and ( ).
  function prettyGraphql(src) {
    const text = String(src == null ? '' : src).replace(/\r\n/g, '\n').trim();
    let out = '';
    let indent = 0;
    const pad = () => '  '.repeat(Math.max(0, indent));
    let i = 0;
    let line = '';
    let inStr = false;
    let strCh = '';
    const flush = () => {
      const t = line.trim();
      if (t) out += pad() + t + '\n';
      line = '';
    };
    while (i < text.length) {
      const ch = text[i];
      if (inStr) {
        line += ch;
        if (ch === '\\' && i + 1 < text.length) {
          line += text[i + 1];
          i += 2;
          continue;
        }
        if (ch === strCh) inStr = false;
        i++;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        strCh = ch;
        line += ch;
        i++;
        continue;
      }
      if (ch === '{') {
        line += ' {';
        flush();
        indent++;
        i++;
        continue;
      }
      if (ch === '}') {
        flush();
        indent--;
        line = '}';
        flush();
        i++;
        continue;
      }
      if (ch === '\n') {
        flush();
        i++;
        continue;
      }
      line += ch;
      i++;
    }
    flush();
    return out.replace(/\n{2,}/g, '\n').trimEnd();
  }

  // --------------------------- HTML / XML -------------------------
  // Basic indentation reflow: put each tag on its own line and indent by
  // nesting depth. Not a real parser — good enough for readability.
  function prettyMarkup(src) {
    const text = String(src == null ? '' : src).replace(/\r\n/g, '\n').trim();
    const withBreaks = text.replace(/>\s*</g, '>\n<');
    const lines = withBreaks.split('\n');
    let indent = 0;
    const out = [];
    const voidTag = /^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr|!doctype|\?xml)/i;
    for (let raw of lines) {
      const t = raw.trim();
      if (!t) continue;
      const isClose = /^<\//.test(t);
      const isSelfClose = /\/>\s*$/.test(t) || voidTag.test(t);
      const isOpen = /^<[^!/?]/.test(t) && !isSelfClose && !/^<[^>]+>.*<\/[^>]+>$/.test(t);
      if (isClose) indent = Math.max(0, indent - 1);
      out.push('  '.repeat(indent) + t);
      if (isOpen) indent++;
    }
    return out.join('\n');
  }

  // --------------------------- Hex dump ---------------------------
  function hexDump(body) {
    const s = String(body == null ? '' : body);
    const rows = [];
    const len = s.length;
    for (let off = 0; off < len; off += 16) {
      const chunk = s.slice(off, off + 16);
      const offStr = off.toString(16).padStart(8, '0');
      let hex = '';
      let ascii = '';
      for (let j = 0; j < 16; j++) {
        if (j < chunk.length) {
          let code = chunk.charCodeAt(j) & 0xff;
          hex += code.toString(16).padStart(2, '0') + ' ';
          ascii += code >= 0x20 && code < 0x7f ? chunk[j] : '.';
        } else {
          hex += '   ';
        }
        if (j === 7) hex += ' ';
      }
      rows.push(offStr + '  ' + hex + ' |' + ascii + '|');
    }
    if (!rows.length) return '(empty body)';
    return rows.join('\n');
  }

  // --------------------------- rendering --------------------------
  function headerBlockHtml(parsed) {
    const head = parsed.headPart || '';
    if (!head) return '';
    return '<div class="mv-headers">' + esc(head) + '</div>';
  }

  function renderPretty(parsed) {
    const ct = contentTypeOf(parsed.headers);
    const body = parsed.body || '';
    const trimmed = body.trim();
    const headersHtml = headerBlockHtml(parsed);

    // JSON (by content-type or by shape)
    if (ct.indexOf('json') >= 0 || looksJson(body)) {
      // GraphQL carried over JSON: has a "query" string field.
      let graphqlInJson = false;
      let parsedJson = null;
      try {
        parsedJson = JSON.parse(trimmed);
        if (parsedJson && typeof parsedJson === 'object' && typeof parsedJson.query === 'string') {
          graphqlInJson = true;
        }
      } catch (e) {
        parsedJson = null;
      }
      if (graphqlInJson) {
        let html = headersHtml;
        html += '<div class="mv-sub">GraphQL query</div>';
        html += '<div class="mv-gql">' + esc(prettyGraphql(parsedJson.query)) + '</div>';
        if (parsedJson.variables !== undefined) {
          html += '<div class="mv-sub">Variables</div>';
          html += '<div class="mv-json">' +
            highlightJsonValue(JSON.stringify(parsedJson.variables, null, 2)) + '</div>';
        }
        return html;
      }
      return headersHtml + '<div class="mv-json">' + prettyJson(trimmed) + '</div>';
    }

    // Raw GraphQL body
    if (ct.indexOf('graphql') >= 0 ||
        /^(query|mutation|subscription|fragment)\b/.test(trimmed)) {
      return headersHtml + '<div class="mv-gql">' + esc(prettyGraphql(body)) + '</div>';
    }

    // HTML / XML
    if (ct.indexOf('html') >= 0 || ct.indexOf('xml') >= 0 ||
        /^<(\?xml|!doctype|html\b)/i.test(trimmed)) {
      return headersHtml + '<div class="mv-markup">' + esc(prettyMarkup(body)) + '</div>';
    }

    // else: raw body verbatim
    return headersHtml + '<div class="mv-plain">' + esc(body) + '</div>';
  }

  // ----------------------------- mount ----------------------------
  function mount(containerEl) {
    if (!containerEl) throw new Error('MsgView.mount: containerEl required');

    containerEl.classList.add('mv-wrap');
    containerEl.textContent = '';

    const tabs = document.createElement('div');
    tabs.className = 'mv-tabs';

    const body = document.createElement('div');
    body.className = 'mv-body raw';

    const tabEls = {};
    MODES.forEach((m) => {
      const b = document.createElement('button');
      b.className = 'mv-tab';
      b.dataset.mode = m;
      b.textContent = m.charAt(0).toUpperCase() + m.slice(1);
      tabs.appendChild(b);
      tabEls[m] = b;
    });

    containerEl.appendChild(tabs);
    containerEl.appendChild(body);

    let currentRaw = '';
    let mode = 'pretty';

    function onTabClick(e) {
      const b = e.target.closest('.mv-tab');
      if (!b) return;
      setMode(b.dataset.mode);
    }
    tabs.addEventListener('click', onTabClick);

    function render() {
      const parsed = parseMessage(currentRaw);
      if (mode === 'raw') {
        body.className = 'mv-body raw';
        body.textContent = currentRaw;
      } else if (mode === 'hex') {
        body.className = 'mv-body raw mv-hex';
        body.textContent = hexDump(parsed.body);
      } else {
        body.className = 'mv-body mv-pretty';
        body.innerHTML = renderPretty(parsed);
      }
      MODES.forEach((m) => tabEls[m].classList.toggle('active', m === mode));
    }

    function setMessage(raw) {
      currentRaw = String(raw == null ? '' : raw);
      render();
    }
    function setMode(m) {
      if (MODES.indexOf(m) < 0) return;
      mode = m;
      render();
    }
    function destroy() {
      tabs.removeEventListener('click', onTabClick);
      containerEl.textContent = '';
      containerEl.classList.remove('mv-wrap');
    }

    render();
    return { setMessage, setMode, destroy, get mode() { return mode; } };
  }

  // ----------------------------- export ---------------------------
  window.MsgView = {
    mount,
    prettyJson,
    looksJson,
    // extras, handy for reuse / testing
    prettyGraphql,
    prettyMarkup,
    hexDump,
    parseMessage,
  };
})();
