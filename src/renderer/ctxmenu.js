'use strict';

/*
 * ctxmenu.js — Burp-style right-click context menus.
 *
 * Browser-safe, no Node. Attaches `window.ContextMenu` with:
 *   show(x, y, items)          render a floating menu at viewport coords
 *   close()                    dismiss the current menu
 *   buildCurl(flow)            -> bash `curl` command string for a flow
 *   historyMenuItems(flow, h)  item array for HTTP history rows
 *   editorMenuItems(flow, h)   item array for request/response editors
 *
 * Item shape: { label, shortcut?, action?, disabled?, danger? } | { separator: true }
 * The builders stay dependency-free: the caller passes a `handlers` object
 * whose functions supply the app wiring. A missing handler disables its item.
 */
(function () {
  // -------------------------------------------------------------- internals
  let menuEl = null; // the single live menu, or null
  let onDocDown = null;
  let onKey = null;
  let onScroll = null;

  function close() {
    if (!menuEl) return;
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close, true);
    window.removeEventListener('scroll', onScroll, true);
    onDocDown = onKey = onScroll = null;
  }

  function show(x, y, items) {
    close(); // one menu at a time

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.setAttribute('role', 'menu');

    (items || []).forEach((it) => {
      if (!it || it.separator) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        menu.appendChild(sep);
        return;
      }
      const row = document.createElement('div');
      row.className = 'ctx-item';
      if (it.disabled) row.classList.add('disabled');
      if (it.danger) row.classList.add('danger');
      row.setAttribute('role', 'menuitem');

      const label = document.createElement('span');
      label.className = 'ctx-label';
      label.textContent = it.label || '';
      row.appendChild(label);

      if (it.shortcut) {
        const sc = document.createElement('span');
        sc.className = 'ctx-shortcut';
        sc.textContent = it.shortcut;
        row.appendChild(sc);
      }

      if (!it.disabled && typeof it.action === 'function') {
        row.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          close();
          try {
            it.action();
          } catch (err) {
            /* swallow: a failing action must not wedge the menu */
            if (window.console) console.error(err);
          }
        });
      }
      menu.appendChild(row);
    });

    // Render off-screen first so we can measure, then clamp to the viewport.
    menu.style.left = '0px';
    menu.style.top = '0px';
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    menuEl = menu;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = menu.getBoundingClientRect();
    let px = x;
    let py = y;
    if (px + rect.width > vw - 4) px = Math.max(4, vw - rect.width - 4);
    if (py + rect.height > vh - 4) py = Math.max(4, vh - rect.height - 4);
    menu.style.left = px + 'px';
    menu.style.top = py + 'px';
    menu.style.visibility = 'visible';

    onDocDown = (e) => {
      if (!menu.contains(e.target)) close();
    };
    onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    onScroll = () => close();
    // capture-phase so we see the click before anything stops it
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close, true);
    window.addEventListener('scroll', onScroll, true);
  }

  // ------------------------------------------------------------- url + curl
  function urlOf(flow) {
    flow = flow || {};
    if (flow.url) return flow.url;
    const scheme = flow.scheme || 'http';
    const host = flow.host || '';
    const path = flow.path || '/';
    return scheme + '://' + host + path;
  }

  // bash single-quote escaping: close quote, emit escaped ', reopen quote
  function shq(s) {
    return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'";
  }

  function buildCurl(flow) {
    flow = flow || {};
    const method = String(flow.method || 'GET').toUpperCase();
    const req = flow.request || {};
    const headers = req.headers || {};
    const body = req.body;

    const parts = ['curl', '-k'];
    if (method !== 'GET') parts.push('-X', method);
    for (const k in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, k)) {
        parts.push('-H', shq(k + ': ' + headers[k]));
      }
    }
    if (body != null && body !== '') parts.push('--data', shq(body));
    parts.push(shq(urlOf(flow)));
    return parts.join(' ');
  }

  // --------------------------------------------------------------- builders
  // `h` (handlers) supplies app functions. Any absent handler -> disabled item.
  function call(fn, arg) {
    return typeof fn === 'function' ? () => fn(arg) : undefined;
  }

  function historyMenuItems(flow, h) {
    h = h || {};
    const hasResp = !!(flow && flow.response);
    return [
      { label: 'Add to scope', action: call(h.addToScope, flow), disabled: !h.addToScope },
      { separator: true },
      { label: 'Send to Repeater', shortcut: '⌘R', action: call(h.sendToRepeater, flow), disabled: !h.sendToRepeater },
      { label: 'Send to Intruder', shortcut: '⌘I', action: call(h.sendToIntruder, flow), disabled: !h.sendToIntruder },
      { label: 'Send to Comparer', action: call(h.sendToComparer, flow), disabled: !h.sendToComparer },
      { separator: true },
      { label: 'Copy URL', action: call(h.copyUrl, flow), disabled: !h.copyUrl },
      { label: 'Copy as curl command (bash)', action: call(h.copyCurl, flow), disabled: !h.copyCurl },
      { label: 'Copy links', action: call(h.copyLinks, flow), disabled: !h.copyLinks || !hasResp },
      { separator: true },
      { label: 'Delete item', action: call(h.deleteItem, flow), disabled: !h.deleteItem, danger: true },
      { label: 'Clear history', action: typeof h.clearHistory === 'function' ? () => h.clearHistory() : undefined, disabled: !h.clearHistory, danger: true },
      { separator: true },
      { label: 'Save item', action: call(h.saveItem, flow), disabled: !h.saveItem },
    ];
  }

  function editorMenuItems(flow, h) {
    h = h || {};
    return [
      { label: 'Send to Repeater', shortcut: '⌘R', action: call(h.sendToRepeater, flow), disabled: !h.sendToRepeater },
      { label: 'Send to Intruder', shortcut: '⌘I', action: call(h.sendToIntruder, flow), disabled: !h.sendToIntruder },
      { label: 'Send to Comparer', action: call(h.sendToComparer, flow), disabled: !h.sendToComparer },
      { separator: true },
      { label: 'Change request method', action: call(h.changeMethod, flow), disabled: !h.changeMethod },
      { separator: true },
      { label: 'Copy URL', action: call(h.copyUrl, flow), disabled: !h.copyUrl },
      { label: 'Copy as curl command (bash)', action: call(h.copyCurl, flow), disabled: !h.copyCurl },
      { label: 'Copy to clipboard', action: call(h.copyToClipboard, flow), disabled: !h.copyToClipboard },
    ];
  }

  window.ContextMenu = {
    show: show,
    close: close,
    buildCurl: buildCurl,
    urlOf: urlOf,
    historyMenuItems: historyMenuItems,
    editorMenuItems: editorMenuItems,
  };
})();
