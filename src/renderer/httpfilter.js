'use strict';
/*
 * httpfilter.js — Burp-style "HTTP history filter" for the Proxy flow table.
 *
 * Browser-safe, no imports; attaches a single global: window.HttpFilter.
 * Operates purely on flow *summaries*:
 *   { id, ts, method, scheme, host, path, url, status, mime, length, inScope }
 *
 * Public API:
 *   HttpFilter.defaultState()            -> fresh state (everything shown)
 *   HttpFilter.matches(summary, state)   -> boolean (should the row be visible)
 *   HttpFilter.mimeClass(mime)           -> 'html'|'script'|'xml'|'css'|'othertext'|'images'|'flash'|'otherbinary'
 *   HttpFilter.isActive(state)           -> true when state differs from default (badge the Filter button)
 *   HttpFilter.formHtml(state)           -> inner HTML for the dialog body (controls reflect state)
 *   HttpFilter.readForm(rootEl)          -> read controls under rootEl into a new state object
 *   HttpFilter.mountDialog(opts)         -> build a reusable modal overlay; returns { open, close, el }
 *
 * NOTE / known limit: a summary carries no request/response *body*. So:
 *   - "Show only parameterized requests" is approximated by the URL having a
 *     query string (a '?'); a body-only parameterized POST cannot be detected.
 *   - the search term matches over `${method} ${url} ${status} ${mime}` only,
 *     never headers or body.
 */
(function () {
  // Canonical default sub-maps (also used by isActive()).
  var DEF_MIME = {
    html: true, script: true, xml: true, css: true,
    othertext: true, images: true, flash: true, otherbinary: true,
  };
  var DEF_STATUS = { '2': true, '3': true, '4': true, '5': true };

  function defaultState() {
    return {
      // Filter by request type
      showOnlyInScope: false,
      hideWithoutResponses: false,
      showOnlyParameterized: false,
      // Filter by MIME type (all on)
      mime: { html: true, script: true, xml: true, css: true, othertext: true, images: true, flash: true, otherbinary: true },
      // Filter by status code (all on; null/no-response governed by hideWithoutResponses)
      status: { '2': true, '3': true, '4': true, '5': true },
      // Filter by search term
      search: { term: '', regex: false, caseSensitive: false, negative: false },
      // Filter by file extension (raw CSV, like Burp's text fields)
      showExt: '',
      hideExt: '',
    };
  }

  function cloneState(s) {
    try { return JSON.parse(JSON.stringify(s)); } catch (e) { return defaultState(); }
  }

  // ---- classification -------------------------------------------------
  // Maps a summary.mime (a full content-type like "text/html" OR a short
  // label like "HTML"/"JSON"/"PNG") into one of Burp's 8 filter buckets.
  // JSON is grouped under 'script' to mirror Burp's classic MIME filter.
  function mimeClass(mime) {
    var m = String(mime == null ? '' : mime).toLowerCase();
    if (!m) return 'otherbinary';
    if (m.indexOf('html') !== -1) return 'html';                 // before xml (xhtml+xml -> html)
    if (m.indexOf('flash') !== -1 || m.indexOf('shockwave') !== -1 || m.indexOf('swf') !== -1) return 'flash';
    if (m.indexOf('image') !== -1 || /(^|[^a-z])(png|jpe?g|gif|bmp|webp|svg|ico|tiff?)([^a-z]|$)/.test(m)) return 'images'; // before xml (svg+xml)
    if (m.indexOf('css') !== -1) return 'css';
    if (m.indexOf('javascript') !== -1 || m.indexOf('ecmascript') !== -1 || m.indexOf('json') !== -1 ||
        /(^|[^a-z])(script|js)([^a-z]|$)/.test(m)) return 'script';
    if (m.indexOf('xml') !== -1) return 'xml';
    if (m.indexOf('text') !== -1 || /(^|[^a-z])(csv|plain|yaml|markdown|md|rtf)([^a-z]|$)/.test(m)) return 'othertext';
    return 'otherbinary';
  }

  // first digit of a status as a bucket key, or '' when not 2xx..5xx
  function statusBucket(status) {
    if (status == null) return '';
    var d = String(status).replace(/^\s+/, '').charAt(0);
    return (d === '2' || d === '3' || d === '4' || d === '5') ? d : '';
  }

  function extOf(path) {
    var p = String(path == null ? '' : path);
    var qi = p.indexOf('?'); if (qi !== -1) p = p.slice(0, qi);
    var hi = p.indexOf('#'); if (hi !== -1) p = p.slice(0, hi);
    var seg = p.split('/').pop() || '';
    var di = seg.lastIndexOf('.');
    if (di <= 0) return ''; // no dot, or a dotfile like ".git"
    return seg.slice(di + 1).toLowerCase();
  }

  function parseCsv(str) {
    return String(str == null ? '' : str)
      .split(',')
      .map(function (s) { return s.trim().toLowerCase().replace(/^\.+/, ''); })
      .filter(function (s) { return s.length > 0; });
  }

  // ---- the predicate --------------------------------------------------
  function matches(summary, state) {
    var f = summary || {};
    var s = state || defaultState();

    // Filter by request type
    if (s.showOnlyInScope && f.inScope === false) return false;
    if (s.hideWithoutResponses && f.status == null) return false;
    if (s.showOnlyParameterized && String(f.url == null ? '' : f.url).indexOf('?') === -1) return false;

    // Filter by MIME type
    var mimeMap = s.mime || DEF_MIME;
    if (mimeMap[mimeClass(f.mime)] === false) return false;

    // Filter by status code (null/no-response is handled by hideWithoutResponses above)
    var b = statusBucket(f.status);
    if (b) {
      var statusMap = s.status || DEF_STATUS;
      if (statusMap[b] === false) return false;
    }

    // Filter by search term
    var se = s.search || {};
    var term = se.term == null ? '' : String(se.term);
    if (term) {
      var hay = (f.method || '') + ' ' + (f.url || '') + ' ' + (f.status == null ? '' : f.status) + ' ' + (f.mime || '');
      var hit;
      if (se.regex) {
        try {
          hit = new RegExp(term, se.caseSensitive ? '' : 'i').test(hay);
        } catch (e) {
          // invalid pattern -> fall back to a literal substring match
          hit = se.caseSensitive ? hay.indexOf(term) !== -1
                                 : hay.toLowerCase().indexOf(term.toLowerCase()) !== -1;
        }
      } else {
        hit = se.caseSensitive ? hay.indexOf(term) !== -1
                               : hay.toLowerCase().indexOf(term.toLowerCase()) !== -1;
      }
      if (se.negative ? hit : !hit) return false;
    }

    // Filter by file extension
    var ext = extOf(f.path);
    var showList = parseCsv(s.showExt);
    if (showList.length && (!ext || showList.indexOf(ext) === -1)) return false;
    var hideList = parseCsv(s.hideExt);
    if (hideList.length && ext && hideList.indexOf(ext) !== -1) return false;

    return true;
  }

  function isActive(state) {
    var s = state || {};
    if (s.showOnlyInScope || s.hideWithoutResponses || s.showOnlyParameterized) return true;
    var m = s.mime || {};
    for (var k in DEF_MIME) if (Object.prototype.hasOwnProperty.call(DEF_MIME, k) && m[k] === false) return true;
    var st = s.status || {};
    for (var j in DEF_STATUS) if (Object.prototype.hasOwnProperty.call(DEF_STATUS, j) && st[j] === false) return true;
    var se = s.search || {};
    if (se.term && String(se.term).trim()) return true;
    if (s.showExt && String(s.showExt).trim()) return true;
    if (s.hideExt && String(s.hideExt).trim()) return true;
    return false;
  }

  // ---- UI -------------------------------------------------------------
  function escAttr(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function check(attr, label, on) {
    return '<label class="hf-check"><input type="checkbox" ' + attr + (on ? ' checked' : '') +
      ' /><span>' + label + '</span></label>';
  }

  function formHtml(state) {
    var s = state || defaultState();
    var m = s.mime || DEF_MIME;
    var st = s.status || DEF_STATUS;
    var se = s.search || {};

    return '' +
      '<div class="hf-grid">' +
        // request type
        '<fieldset class="hf-group">' +
          '<legend class="hf-legend">Request type</legend>' +
          check('data-ft="scope"', 'Show only in-scope items', s.showOnlyInScope) +
          check('data-ft="hasresp"', 'Hide items without responses', s.hideWithoutResponses) +
          check('data-ft="param"', 'Show only parameterized requests', s.showOnlyParameterized) +
        '</fieldset>' +
        // status
        '<fieldset class="hf-group">' +
          '<legend class="hf-legend">Status code</legend>' +
          '<div class="hf-cols">' +
            check('data-status="2"', '2xx', st['2'] !== false) +
            check('data-status="3"', '3xx', st['3'] !== false) +
            check('data-status="4"', '4xx', st['4'] !== false) +
            check('data-status="5"', '5xx', st['5'] !== false) +
          '</div>' +
        '</fieldset>' +
        // mime
        '<fieldset class="hf-group hf-span">' +
          '<legend class="hf-legend">MIME type</legend>' +
          '<div class="hf-cols hf-cols-4">' +
            check('data-mime="html"', 'HTML', m.html !== false) +
            check('data-mime="script"', 'Script', m.script !== false) +
            check('data-mime="xml"', 'XML', m.xml !== false) +
            check('data-mime="css"', 'CSS', m.css !== false) +
            check('data-mime="othertext"', 'Other text', m.othertext !== false) +
            check('data-mime="images"', 'Images', m.images !== false) +
            check('data-mime="flash"', 'Flash', m.flash !== false) +
            check('data-mime="otherbinary"', 'Other binary', m.otherbinary !== false) +
          '</div>' +
        '</fieldset>' +
        // search
        '<fieldset class="hf-group hf-span">' +
          '<legend class="hf-legend">Search term</legend>' +
          '<input class="input hf-input" data-search="term" placeholder="matches method, URL, status &amp; MIME" value="' + escAttr(se.term) + '" />' +
          '<div class="hf-cols hf-cols-3">' +
            check('data-search="regex"', 'Regex', !!se.regex) +
            check('data-search="case"', 'Case sensitive', !!se.caseSensitive) +
            check('data-search="negative"', 'Negative search', !!se.negative) +
          '</div>' +
        '</fieldset>' +
        // extensions
        '<fieldset class="hf-group hf-span">' +
          '<legend class="hf-legend">File extension</legend>' +
          '<div class="hf-ext-row"><span class="hf-ext-label">Show only:</span>' +
            '<input class="input hf-input" data-ext="show" placeholder="e.g. php,asp,jsp" value="' + escAttr(s.showExt) + '" /></div>' +
          '<div class="hf-ext-row"><span class="hf-ext-label">Hide:</span>' +
            '<input class="input hf-input" data-ext="hide" placeholder="e.g. js,gif,jpg,png,css" value="' + escAttr(s.hideExt) + '" /></div>' +
        '</fieldset>' +
      '</div>';
  }

  function readForm(root) {
    if (!root) return defaultState();
    var s = defaultState();
    var get = function (sel) { return root.querySelector(sel); };
    var all = function (sel) { return Array.prototype.slice.call(root.querySelectorAll(sel)); };
    var ck = function (sel) { var el = get(sel); return !!(el && el.checked); };
    var val = function (sel) { var el = get(sel); return el ? el.value : ''; };

    s.showOnlyInScope = ck('[data-ft="scope"]');
    s.hideWithoutResponses = ck('[data-ft="hasresp"]');
    s.showOnlyParameterized = ck('[data-ft="param"]');
    all('[data-mime]').forEach(function (el) { s.mime[el.getAttribute('data-mime')] = el.checked; });
    all('[data-status]').forEach(function (el) { s.status[el.getAttribute('data-status')] = el.checked; });
    s.search.term = val('[data-search="term"]');
    s.search.regex = ck('[data-search="regex"]');
    s.search.caseSensitive = ck('[data-search="case"]');
    s.search.negative = ck('[data-search="negative"]');
    s.showExt = val('[data-ext="show"]');
    s.hideExt = val('[data-ext="hide"]');
    return s;
  }

  // Build a reusable modal overlay (reuses .overlay / .overlay-card look).
  // opts.onApply(state) is called on "Apply" and "Apply & close".
  function mountDialog(opts) {
    opts = opts || {};
    var overlay = document.createElement('div');
    overlay.className = 'overlay hf-overlay hidden';
    overlay.innerHTML = '' +
      '<div class="overlay-card hf-card">' +
        '<div class="overlay-head"><span>HTTP history filter</span>' +
          '<button class="btn sm" data-hf="x">Close</button></div>' +
        '<div class="hf-body" data-hf="body"></div>' +
        '<div class="hf-foot">' +
          '<button class="btn sm" data-hf="showall">Show all</button>' +
          '<button class="btn sm" data-hf="hideall">Hide all</button>' +
          '<div class="spacer"></div>' +
          '<button class="btn sm" data-hf="cancel">Cancel</button>' +
          '<button class="btn sm" data-hf="apply">Apply</button>' +
          '<button class="btn sm primary" data-hf="applyclose">Apply &amp; close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    var body = overlay.querySelector('[data-hf="body"]');

    function open(state) {
      body.innerHTML = formHtml(cloneState(state || defaultState()));
      overlay.classList.remove('hidden');
    }
    function close() { overlay.classList.add('hidden'); }
    function setBulk(on) {
      Array.prototype.slice.call(body.querySelectorAll('[data-mime],[data-status]'))
        .forEach(function (el) { el.checked = on; });
    }
    function apply() { if (opts.onApply) opts.onApply(readForm(body)); }

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) { close(); return; } // backdrop click
      var btn = e.target.closest ? e.target.closest('[data-hf]') : null;
      if (!btn) return;
      switch (btn.getAttribute('data-hf')) {
        case 'x': case 'cancel': close(); break;
        case 'showall': setBulk(true); break;
        case 'hideall': setBulk(false); break;
        case 'apply': apply(); break;
        case 'applyclose': apply(); close(); break;
      }
    });

    return { open: open, close: close, el: overlay };
  }

  window.HttpFilter = {
    defaultState: defaultState,
    cloneState: cloneState,
    matches: matches,
    mimeClass: mimeClass,
    isActive: isActive,
    formHtml: formHtml,
    readForm: readForm,
    mountDialog: mountDialog,
    extOf: extOf,
  };
})();
