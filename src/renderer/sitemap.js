'use strict';
/*
 * sitemap.js — TARGET / SITEMAP tree.
 *
 * Browser-safe, no Node APIs. Attaches a single global: window.SiteMap.
 *
 * Flow summaries look like:
 *   { id, method, scheme, host, path, url, status, mime, length }
 *
 * Public API (window.SiteMap):
 *   build(flowsArray)            -> tree (root node)
 *   render(tree, opts)           -> HTMLElement (a `.tree` container)
 *   mount(container, opts)       -> controller { update, rebuild, select, el }
 *
 * The tree groups flows by "scheme://host", then nests the request path
 * segments. Every node tracks the flow ids that terminate at it plus the
 * aggregated methods / statuses / count for its whole subtree.
 */
(function (global) {
  var SEP = '\u0000'; // key separator that cannot appear in a host/path

  // --------------------------- model ---------------------------

  function makeNode(fields) {
    return Object.assign(
      {
        key: '',
        label: '',
        isHost: false,
        host: '',
        scheme: '',
        fullPath: '', // path for this node, '' for a host root
        depth: 0,
        childMap: Object.create(null), // segment -> node (build-time)
        children: [], // sorted array (finalised)
        flowIds: [], // flows that terminate at THIS node
        methods: null, // Set, aggregated over subtree (finalised -> array)
        statuses: null, // Set, aggregated over subtree (finalised -> array)
        count: 0, // number of flows in subtree
      },
      fields || {}
    );
  }

  // Split a request path into pathname segments, dropping the query string.
  function pathSegments(path) {
    if (!path) return [];
    var p = String(path);
    var q = p.indexOf('?');
    if (q >= 0) p = p.slice(0, q);
    var h = p.indexOf('#');
    if (h >= 0) p = p.slice(0, h);
    var out = [];
    var parts = p.split('/');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].length) out.push(parts[i]);
    }
    return out;
  }

  // Build a tree (root node) from an array of flow summaries.
  function build(flows) {
    var root = makeNode({ key: 'root', label: 'root', depth: -1 });
    if (!flows) return finalise(root);

    for (var i = 0; i < flows.length; i++) {
      var f = flows[i];
      if (!f || f.host == null) continue;
      var scheme = f.scheme || 'http';
      var hostKey = scheme + '://' + f.host;

      var hostNode = root.childMap[hostKey];
      if (!hostNode) {
        hostNode = makeNode({
          key: hostKey,
          label: f.host,
          isHost: true,
          host: f.host,
          scheme: scheme,
          fullPath: '',
          depth: 0,
        });
        root.childMap[hostKey] = hostNode;
      }

      var segs = pathSegments(f.path);
      var node = hostNode;
      var acc = '';
      for (var s = 0; s < segs.length; s++) {
        acc += '/' + segs[s];
        var seg = segs[s];
        var child = node.childMap[seg];
        if (!child) {
          child = makeNode({
            key: hostKey + SEP + acc,
            label: seg,
            host: f.host,
            scheme: scheme,
            fullPath: acc,
            depth: node.depth + 1,
          });
          node.childMap[seg] = child;
        }
        node = child;
      }

      // `node` is where this flow terminates (host root if path was "/").
      node.flowIds.push(f.id);
      addAgg(node, f);
    }

    return finalise(root);
  }

  function addAgg(node, f) {
    if (!node.methods) node.methods = Object.create(null);
    if (!node.statuses) node.statuses = Object.create(null);
    if (f.method) node.methods[f.method] = true;
    if (f.status != null && f.status !== '') node.statuses[String(f.status)] = true;
  }

  // Convert childMap -> sorted children arrays and roll up aggregates/counts.
  function finalise(node) {
    var keys = Object.keys(node.childMap);
    keys.sort(function (a, b) {
      var A = node.childMap[a];
      var B = node.childMap[b];
      // folders (with children) before pure leaves, then case-insensitive label
      var af = Object.keys(A.childMap).length ? 0 : 1;
      var bf = Object.keys(B.childMap).length ? 0 : 1;
      if (af !== bf) return af - bf;
      var la = A.label.toLowerCase();
      var lb = B.label.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    });

    var methods = Object.create(null);
    var statuses = Object.create(null);
    var count = node.flowIds.length;

    // seed with this node's own direct methods/statuses
    if (node.methods) for (var m in node.methods) methods[m] = true;
    if (node.statuses) for (var st in node.statuses) statuses[st] = true;

    node.children = [];
    for (var i = 0; i < keys.length; i++) {
      var child = finalise(node.childMap[keys[i]]);
      node.children.push(child);
      count += child.count;
      for (var cm = 0; cm < child.methods.length; cm++) methods[child.methods[cm]] = true;
      for (var cs = 0; cs < child.statuses.length; cs++) statuses[child.statuses[cs]] = true;
    }

    node.methods = Object.keys(methods).sort();
    node.statuses = Object.keys(statuses).sort();
    node.count = count;
    node.childMap = null; // free build-time map
    return node;
  }

  // ------------------------- rendering -------------------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function statusKind(statuses) {
    // return the "worst" leading digit among statuses for coloring
    var worst = 0;
    for (var i = 0; i < statuses.length; i++) {
      var d = parseInt(String(statuses[i])[0], 10);
      if (d > worst) worst = d;
    }
    return worst;
  }

  // Build one node's DOM (recursively). `opts` carries { expanded, selected }.
  function nodeEl(node, opts) {
    var wrap = document.createElement('div');
    wrap.className = 'tree-node' + (node.isHost ? ' is-host' : '');
    wrap.dataset.key = node.key;

    var hasChildren = node.children.length > 0;
    var isExpanded = opts.expanded && opts.expanded.has(node.key);
    if (hasChildren && !isExpanded) wrap.classList.add('collapsed');

    var row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.key = node.key;
    if (node.flowIds.length) {
      row.classList.add('has-flow');
      // select the most recently captured flow that lives at this node
      row.dataset.flow = node.flowIds[node.flowIds.length - 1];
    }
    if (opts.selected != null && row.dataset.flow === String(opts.selected)) {
      row.classList.add('selected');
    }

    var toggle = document.createElement('span');
    toggle.className = 'tree-toggle';
    if (!hasChildren) toggle.classList.add('leaf');
    row.appendChild(toggle);

    var icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = node.isHost ? '\u25C9' : hasChildren ? '\u25B8' : '\u2022';
    row.appendChild(icon);

    var label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.isHost ? node.scheme + '://' + node.label : node.label || '/';
    label.title = node.isHost ? node.scheme + '://' + node.host : node.fullPath || '/';
    row.appendChild(label);

    var badges = document.createElement('span');
    badges.className = 'tree-badges';
    if (node.methods.length) {
      var mspan = document.createElement('span');
      mspan.className = 'tree-methods';
      mspan.textContent = node.methods.join(' ');
      badges.appendChild(mspan);
    }
    if (node.statuses.length) {
      var sspan = document.createElement('span');
      sspan.className = 'tree-status st-' + statusKind(node.statuses);
      sspan.textContent = node.statuses.join(',');
      badges.appendChild(sspan);
    }
    var cspan = document.createElement('span');
    cspan.className = 'tree-count';
    cspan.textContent = node.count;
    badges.appendChild(cspan);
    row.appendChild(badges);

    wrap.appendChild(row);

    if (hasChildren) {
      var kids = document.createElement('div');
      kids.className = 'tree-children';
      for (var i = 0; i < node.children.length; i++) {
        kids.appendChild(nodeEl(node.children[i], opts));
      }
      wrap.appendChild(kids);
    }

    return wrap;
  }

  // Render a tree into a fresh `.tree` container element.
  function render(tree, opts) {
    opts = opts || {};
    var el = document.createElement('div');
    el.className = 'tree';
    var children = (tree && tree.children) || [];
    if (!children.length) {
      var empty = document.createElement('div');
      empty.className = 'tree-empty muted';
      empty.textContent = 'No requests captured yet.';
      el.appendChild(empty);
      return el;
    }
    for (var i = 0; i < children.length; i++) {
      el.appendChild(nodeEl(children[i], opts));
    }
    return el;
  }

  // --------------------------- mount ---------------------------

  // Stateful controller: keeps expand/selection state and re-renders in place.
  function mount(container, opts) {
    opts = opts || {};
    var onSelect = typeof opts.onSelect === 'function' ? opts.onSelect : function () {};
    var expanded = new Set();
    var seenHosts = new Set();
    var selected = null;
    var tree = build([]);

    var el = document.createElement('div');
    el.className = 'tree';
    if (container) container.appendChild(el);

    // Event delegation for expand/collapse + selection.
    el.addEventListener('click', function (e) {
      var toggle = e.target.closest ? e.target.closest('.tree-toggle') : null;
      if (toggle && !toggle.classList.contains('leaf')) {
        var wrap = toggle.closest('.tree-node');
        if (wrap) {
          var key = wrap.dataset.key;
          var nowCollapsed = wrap.classList.toggle('collapsed');
          if (nowCollapsed) expanded.delete(key);
          else expanded.add(key);
        }
        e.stopPropagation();
        return;
      }
      var row = e.target.closest ? e.target.closest('.tree-row') : null;
      if (!row) return;
      if (row.dataset.flow != null && row.dataset.flow !== '') {
        selected = row.dataset.flow;
        markSelected();
        onSelect(selected);
      } else {
        // clicking a folder row toggles it too
        var w = row.parentNode;
        if (w && w.classList.contains('tree-node') && w.querySelector('.tree-children')) {
          var k = w.dataset.key;
          if (w.classList.toggle('collapsed')) expanded.delete(k);
          else expanded.add(k);
        }
      }
    });

    function markSelected() {
      var rows = el.querySelectorAll('.tree-row.selected');
      for (var i = 0; i < rows.length; i++) rows[i].classList.remove('selected');
      if (selected == null) return;
      var match = el.querySelector('.tree-row[data-flow="' + cssEscape(selected) + '"]');
      if (match) match.classList.add('selected');
    }

    function cssEscape(v) {
      return String(v).replace(/["\\]/g, '\\$&');
    }

    // Rebuild the whole tree from a flows array (Map values or an array).
    function rebuild(flows) {
      var arr = toArray(flows);
      tree = build(arr);
      // auto-expand each host the first time we see it
      for (var i = 0; i < tree.children.length; i++) {
        var h = tree.children[i];
        if (!seenHosts.has(h.key)) {
          seenHosts.add(h.key);
          expanded.add(h.key);
        }
      }
      var fresh = render(tree, { expanded: expanded, selected: selected });
      el.innerHTML = '';
      while (fresh.firstChild) el.appendChild(fresh.firstChild);
    }

    return {
      el: el,
      get tree() {
        return tree;
      },
      update: rebuild, // incremental use = full rebuild preserving state
      rebuild: rebuild,
      select: function (flowId) {
        selected = flowId == null ? null : String(flowId);
        markSelected();
      },
    };
  }

  function toArray(flows) {
    if (!flows) return [];
    if (Array.isArray(flows)) return flows;
    if (typeof flows.values === 'function') return Array.from(flows.values()); // Map/Set
    return Array.prototype.slice.call(flows);
  }

  global.SiteMap = {
    build: build,
    render: render,
    mount: mount,
    _pathSegments: pathSegments, // exposed for debugging/tests
  };
})(typeof window !== 'undefined' ? window : this);
