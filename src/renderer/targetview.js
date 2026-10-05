'use strict';
/*
 * targetview.js — TARGET / SITE MAP contents table.
 *
 * Browser-safe, no Node APIs. Attaches a single global: window.TargetView.
 *
 * Burp's Target tab shows, for the selected site-map node, a "Contents"
 * table listing every request under that subtree (a mini HTTP history),
 * and below it a Request/Response viewer. This module owns the contents
 * table: picking the matching flow summaries for a node and rendering the
 * rows with the same look as the proxy flow table (m-GET etc, st-2..5).
 *
 * Flow summaries look like (same shape SiteMap consumes):
 *   { id, method, scheme, host, path, url, status, mime, length }
 *
 * Public API (window.TargetView):
 *   rowsForNode(flows, node)      -> Array<summary>   (flows under the node)
 *   renderRows(rows, selectedId)  -> String (innerHTML for a <tbody>)
 *   predicateFor(node, flows)     -> fn(summary)->bool
 *   fmtLen(n) / statusClass(s)    -> formatting helpers (self-contained)
 *
 * `node` may be, in order of preference:
 *   - null / undefined            -> every flow (whole site map)
 *   - a function                  -> used directly as the predicate
 *   - a flow id (string/number)   -> look it up in `flows`, then match its
 *                                    host + path subtree
 *   - a SiteMap node              -> { host, fullPath[, isHost] } -> host +
 *                                    path-prefix subtree match
 *   - { predicate }               -> custom predicate
 *   - { flowId }                  -> same as passing the id
 *   - { host, pathPrefix|path|fullPath } -> host + path-prefix subtree match
 *   - { flowIds: Set|Array }      -> membership match on flow id
 */
(function (global) {
  // ------------------------- collection utils -------------------------

  function toArray(flows) {
    if (!flows) return [];
    if (Array.isArray(flows)) return flows;
    if (typeof flows.values === 'function') return Array.from(flows.values()); // Map/Set
    return Array.prototype.slice.call(flows);
  }

  function findById(arr, id) {
    var want = String(id);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && String(arr[i].id) === want) return arr[i];
    }
    return null;
  }

  // ------------------------- path helpers -------------------------

  // Pathname only: drop query string and fragment.
  function pathname(p) {
    if (!p) return '/';
    var s = String(p);
    var q = s.indexOf('?');
    if (q >= 0) s = s.slice(0, q);
    var h = s.indexOf('#');
    if (h >= 0) s = s.slice(0, h);
    return s || '/';
  }

  function segments(p) {
    var out = [];
    var parts = pathname(p).split('/');
    for (var i = 0; i < parts.length; i++) if (parts[i].length) out.push(parts[i]);
    return out;
  }

  // Is `prefSegs` a (segment-wise) prefix of `segs`? Empty prefix matches all.
  function isSegPrefix(prefSegs, segs) {
    if (prefSegs.length > segs.length) return false;
    for (var i = 0; i < prefSegs.length; i++) {
      if (prefSegs[i] !== segs[i]) return false;
    }
    return true;
  }

  // Match on scheme://host + path subtree. scheme is optional (ignored when
  // not given, so a node without a scheme still matches both http/https).
  function hostPathPredicate(host, scheme, prefix) {
    var ps = segments(prefix);
    return function (f) {
      if (!f || f.host !== host) return false;
      if (scheme && f.scheme && f.scheme !== scheme) return false;
      return isSegPrefix(ps, segments(f.path));
    };
  }

  // ------------------------- predicate resolution -------------------------

  function predicateFor(node, flows) {
    var arr = toArray(flows);

    if (node == null) return function () { return true; };
    if (typeof node === 'function') return node;

    // A bare flow id (string or number).
    if (typeof node === 'string' || typeof node === 'number') {
      var f0 = findById(arr, node);
      if (!f0) return function () { return false; };
      return hostPathPredicate(f0.host, f0.scheme, pathname(f0.path));
    }

    if (typeof node === 'object') {
      if (typeof node.predicate === 'function') return node.predicate;

      if (node.flowIds) {
        var set =
          typeof node.flowIds.has === 'function'
            ? node.flowIds
            : new Set((node.flowIds || []).map(String));
        var has =
          typeof set.has === 'function' && !(set instanceof Set)
            ? function (id) { return set.has(id); }
            : function (id) { return set.has(String(id)); };
        return function (f) { return !!f && has(f.id); };
      }

      if (node.flowId != null) {
        var f1 = findById(arr, node.flowId);
        if (!f1) return function () { return false; };
        return hostPathPredicate(f1.host, f1.scheme, pathname(f1.path));
      }

      if (node.host != null) {
        var prefix = node.pathPrefix != null ? node.pathPrefix
          : node.fullPath != null ? node.fullPath
          : node.path != null ? node.path
          : '';
        // A host node (isHost) ignores any path and matches the whole host.
        if (node.isHost) prefix = '';
        return hostPathPredicate(node.host, node.scheme, prefix);
      }
    }

    // Unknown shape -> match nothing (safer than matching everything).
    return function () { return false; };
  }

  function rowsForNode(flows, node) {
    var arr = toArray(flows);
    var pred = predicateFor(node, arr);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (pred(arr[i])) out.push(arr[i]);
    }
    return out;
  }

  // ------------------------- rendering -------------------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtLen(n) {
    if (n == null || n === '') return '';
    var num = Number(n);
    if (!isFinite(num)) return '';
    if (num < 1024) return num + ' B';
    if (num < 1024 * 1024) return (num / 1024).toFixed(1) + ' KB';
    return (num / 1024 / 1024).toFixed(1) + ' MB';
  }

  function statusClass(s) {
    if (!s) return '';
    return 'st-' + String(s)[0];
  }

  function rowHtml(f, selectedId) {
    var selected = selectedId != null && String(f.id) === String(selectedId);
    var pathOrUrl = f.path != null && f.path !== '' ? f.path : f.url || '';
    return (
      '<tr data-id="' + esc(f.id) + '"' + (selected ? ' class="selected"' : '') + '>' +
      '<td class="method m-' + esc(f.method) + '">' + esc(f.method) + '</td>' +
      '<td title="' + esc(pathOrUrl) + '">' + esc(pathOrUrl) + '</td>' +
      '<td class="' + statusClass(f.status) + '">' + esc(f.status || '') + '</td>' +
      '<td class="muted">' + esc(fmtLen(f.length)) + '</td>' +
      '<td class="muted" title="' + esc(f.mime || '') + '">' + esc(f.mime || '') + '</td>' +
      '</tr>'
    );
  }

  function renderRows(rows, selectedId) {
    if (!rows || !rows.length) return '';
    var html = '';
    for (var i = 0; i < rows.length; i++) html += rowHtml(rows[i], selectedId);
    return html;
  }

  global.TargetView = {
    rowsForNode: rowsForNode,
    renderRows: renderRows,
    predicateFor: predicateFor,
    fmtLen: fmtLen,
    statusClass: statusClass,
    _pathname: pathname, // exposed for debugging/tests
    _segments: segments,
    _isSegPrefix: isSegPrefix,
  };
})(typeof window !== 'undefined' ? window : this);
