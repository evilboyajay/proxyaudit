'use strict';

/*
 * MsgSearch — Burp-style search bar for HTTP message editors.
 *
 * Browser-safe (no Node APIs). Attaches window.MsgSearch.
 *
 *   const s = MsgSearch.attach(el);              // <textarea>, <pre> or <div>
 *   const s = MsgSearch.attach(el, { barHost }); // put the bar in barHost
 *   s.refresh(); s.setTerm('token'); s.focus(); s.destroy();
 *
 * Like Burp's message-editor search: a field under the message with
 * previous / next buttons, a live match count, every match highlighted and
 * the current one emphasised, plus options for case sensitivity, regex and
 * "auto-scroll to match when text changes" (handy in Repeater: resend and
 * the view jumps straight to the match). The term survives content changes,
 * so the new response is re-highlighted automatically.
 *
 * Read-only viewers get <mark> elements spliced into their text nodes (so
 * syntax highlighting is preserved, and matches may span token spans).
 * Textareas can't contain markup: they are wrapped by CodeEditor, whose
 * coloured overlay draws the highlights (passed in as options.editor).
 */
(function () {
  const MAX_HITS = 5000; // cap DOM work on huge bodies
  const OPTS_KEY = 'proxyaudit.search.opts';
  const instances = new Set();
  let lastUsed = null;

  function loadOpts() {
    try {
      const o = JSON.parse(localStorage.getItem(OPTS_KEY) || '{}');
      return { case: !!o.case, regex: !!o.regex, auto: !!o.auto };
    } catch (_) {
      return { case: false, regex: false, auto: false };
    }
  }
  function saveOpts(o) {
    try {
      localStorage.setItem(OPTS_KEY, JSON.stringify(o));
    } catch (_) {
      /* ignore */
    }
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Returns { hits: [[start, end], ...], error, capped }.
  function findAll(text, term, opts) {
    if (!term) return { hits: [], error: null, capped: false };
    let re;
    try {
      const src = opts.regex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(src, 'g' + (opts.case ? '' : 'i') + 'm');
    } catch (e) {
      return { hits: [], error: 'Invalid regex', capped: false };
    }
    const hits = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++; // zero-width match: never highlight, just advance
        continue;
      }
      hits.push([m.index, m.index + m[0].length]);
      if (hits.length >= MAX_HITS) return { hits, error: null, capped: true };
    }
    return { hits, error: null, capped: false };
  }

  // Scroll `el` into the middle of its nearest scrollable ancestor without
  // touching outer (overflow:hidden) layout containers like scrollIntoView can.
  function scrollToEl(el, stopAt) {
    let sc = el.parentElement;
    while (sc && sc !== document.body) {
      const cs = getComputedStyle(sc);
      const y = /(auto|scroll)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight;
      const x = /(auto|scroll)/.test(cs.overflowX) && sc.scrollWidth > sc.clientWidth;
      if (x || y) break;
      if (sc === stopAt) {
        sc = null;
        break;
      }
      sc = sc.parentElement;
    }
    if (!sc || sc === document.body) return;
    const r = el.getBoundingClientRect();
    const c = sc.getBoundingClientRect();
    sc.scrollTop += r.top - c.top - sc.clientHeight / 2 + r.height / 2;
    if (r.left < c.left || r.right > c.left + sc.clientWidth) {
      sc.scrollLeft += r.left - c.left - sc.clientWidth / 3;
    }
  }

  const OPT_LABELS = [
    ['case', 'Case sensitive'],
    ['regex', 'Regex'],
    ['auto', 'Auto-scroll to match when text changes'],
  ];
  function buildBar(opts) {
    const bar = document.createElement('div');
    bar.className = 'ms-bar';
    bar.innerHTML =
      '<button type="button" class="ms-btn ms-gear" title="Search options">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>' +
      '</button>' +
      '<button type="button" class="ms-btn ms-prev" title="Previous match (Shift+Enter)">←</button>' +
      '<button type="button" class="ms-btn ms-next" title="Next match (Enter)">→</button>' +
      '<input class="ms-input" type="text" spellcheck="false" placeholder="Search..." />' +
      '<span class="ms-count">0 highlights</span>' +
      '<div class="ms-menu hidden">' +
      OPT_LABELS.map(
        ([k, label]) =>
          `<label class="ms-menu-item"><input type="checkbox" data-o="${k}"${opts[k] ? ' checked' : ''} /> ${label}</label>`
      ).join('') +
      '</div>';
    return bar;
  }

  function attach(target, options = {}) {
    if (!target) throw new Error('MsgSearch.attach: target required');
    const isTA = target.tagName === 'TEXTAREA';
    const opts = loadOpts();
    const bar = buildBar(opts);
    const input = bar.querySelector('.ms-input');
    const countEl = bar.querySelector('.ms-count');

    // Textareas can't hold markup: their highlights are drawn by the
    // editor overlay that owns them (CodeEditor), via options.editor.
    const editor = options.editor || null;
    if (isTA && !editor) throw new Error('MsgSearch.attach: textarea needs options.editor');

    // ---- layout -------------------------------------------------------
    let wrap = null;
    let classObserver = null;
    if (options.barHost) {
      options.barHost.appendChild(bar);
    } else {
      wrap = document.createElement('div');
      wrap.className = 'ms-wrap';
      target.parentNode.insertBefore(wrap, target);
      wrap.appendChild(target);
      wrap.appendChild(bar);
      // App code toggles .hidden on the original element; mirror it so the
      // bar disappears with its viewer.
      const syncHidden = () => wrap.classList.toggle('hidden', target.classList.contains('hidden'));
      syncHidden();
      classObserver = new MutationObserver(syncHidden);
      classObserver.observe(target, { attributes: true, attributeFilter: ['class'] });
    }
    const root = wrap || options.barHost;

    let term = '';
    let hits = [];
    let current = -1;

    function renderTextarea(scroll) {
      editor.setHits(term ? hits : [], current, scroll);
    }

    // ---- view (pre/div) highlighting ---------------------------------
    let observer = null;
    let ignoreMutations = false;
    function clearMarks() {
      const marks = target.querySelectorAll('mark.ms-hit');
      if (!marks.length) return;
      marks.forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
      target.normalize();
    }
    function textNodes() {
      const out = [];
      const w = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) out.push(n);
      return out;
    }
    function renderView(scroll) {
      ignoreMutations = true;
      try {
        clearMarks();
        if (term && hits.length) {
          const nodes = textNodes();
          let off = 0;
          let h = 0;
          for (const node of nodes) {
            const t = node.nodeValue;
            const start = off;
            const end = off + t.length;
            off = end;
            while (h < hits.length && hits[h][1] <= start) h++;
            if (h >= hits.length) break;
            if (hits[h][0] >= end) continue;
            const frag = document.createDocumentFragment();
            let pos = 0;
            let k = h;
            while (k < hits.length && hits[k][0] < end) {
              const a = Math.max(hits[k][0], start) - start;
              const b = Math.min(hits[k][1], end) - start;
              if (a > pos) frag.appendChild(document.createTextNode(t.slice(pos, a)));
              const mk = document.createElement('mark');
              mk.className = 'ms-hit' + (k === current ? ' ms-cur' : '');
              mk.dataset.hit = k;
              mk.textContent = t.slice(a, b);
              frag.appendChild(mk);
              pos = b;
              if (hits[k][1] > end) break; // continues into the next node
              k++;
            }
            if (pos < t.length) frag.appendChild(document.createTextNode(t.slice(pos)));
            node.replaceWith(frag);
            h = k;
          }
        }
      } finally {
        if (observer) observer.takeRecords();
        ignoreMutations = false;
      }
      if (scroll && current >= 0) {
        const cur = target.querySelector('mark.ms-cur');
        if (cur) scrollToEl(cur, root);
      }
    }

    // ---- core ---------------------------------------------------------
    function text() {
      if (isTA) return target.value;
      // Match against the plain text (marks removed) so offsets line up
      // with the tree walk in renderView.
      return target.textContent;
    }
    function updateCount(res) {
      input.classList.toggle('ms-bad', !!res.error);
      const n = hits.length + (res.capped ? '+' : '');
      if (res.error) countEl.textContent = res.error;
      else countEl.textContent = `${n} highlight${hits.length === 1 ? '' : 's'}`;
      countEl.title = hits.length ? `Match ${current + 1} of ${n}` : '';
      bar.classList.toggle('ms-none', !!term && !hits.length);
    }
    // keep: keep the current index (clamped) instead of resetting to the
    // first match; scroll: bring the current match into view.
    function refresh({ keep = false, scroll = false } = {}) {
      const res = findAll(text(), term, opts);
      hits = res.hits;
      if (!hits.length) current = -1;
      else if (!keep || current < 0) current = 0;
      else current = Math.min(current, hits.length - 1);
      if (isTA) renderTextarea(scroll);
      else renderView(scroll);
      updateCount(res);
    }
    function step(dir) {
      if (!hits.length) return;
      current = (current + dir + hits.length) % hits.length;
      // Re-mark without recomputing (content hasn't changed).
      if (isTA) renderTextarea(true);
      else renderView(true);
      updateCount({ error: null, capped: hits.length >= MAX_HITS });
    }
    // Content changed underneath us (new response, edited request, ...).
    function onContentChange() {
      if (!term) return;
      refresh({ keep: !opts.auto, scroll: opts.auto });
    }

    // ---- wiring -------------------------------------------------------
    let pending = false;
    function schedule() {
      if (pending) return;
      pending = true;
      Promise.resolve().then(() => {
        pending = false;
        onContentChange();
      });
    }

    if (!isTA) {
      observer = new MutationObserver(() => {
        if (!ignoreMutations) schedule();
      });
      observer.observe(target, { childList: true, characterData: true, subtree: true });
    }

    input.addEventListener('input', () => {
      term = input.value;
      refresh({ scroll: true });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        step(e.shiftKey ? -1 : 1);
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        if (input.value) {
          input.value = '';
          term = '';
          refresh();
        } else {
          input.blur();
        }
      }
    });
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('.ms-btn');
      if (!b) return;
      if (b.classList.contains('ms-prev')) step(-1);
      else if (b.classList.contains('ms-next')) step(1);
      else if (b.classList.contains('ms-gear')) {
        menu.classList.toggle('hidden');
        e.stopPropagation();
      }
    });
    const menu = bar.querySelector('.ms-menu');
    menu.addEventListener('change', (e) => {
      const k = e.target.dataset.o;
      if (!k) return;
      opts[k] = e.target.checked;
      saveOpts(opts);
      bar.classList.toggle('ms-has-opts', opts.case || opts.regex);
      if (k !== 'auto') refresh({ scroll: true });
    });
    bar.classList.toggle('ms-has-opts', opts.case || opts.regex);
    const closeMenu = (e) => {
      if (!menu.classList.contains('hidden') && !menu.contains(e.target)) menu.classList.add('hidden');
    };
    document.addEventListener('mousedown', closeMenu);
    const markUsed = () => {
      lastUsed = api;
    };
    root.addEventListener('focusin', markUsed);
    root.addEventListener('mousedown', markUsed);

    const api = {
      root,
      target,
      refresh: () => refresh({ keep: true }),
      contentChanged: () => schedule(),
      setTerm(t) {
        input.value = t == null ? '' : String(t);
        term = input.value;
        refresh({ scroll: true });
      },
      get term() {
        return term;
      },
      get count() {
        return hits.length;
      },
      focus() {
        // Seed the field with a single-line selection from this editor.
        let sel = '';
        if (isTA && document.activeElement === target) {
          sel = target.value.slice(target.selectionStart, target.selectionEnd);
        } else if (!isTA) {
          const s = window.getSelection && window.getSelection();
          if (s && s.rangeCount && target.contains(s.anchorNode)) sel = s.toString();
        }
        if (sel && !/\n/.test(sel) && sel.length < 200) api.setTerm(sel);
        input.focus();
        input.select();
        lastUsed = api;
      },
      visible() {
        return !!(bar.offsetParent || bar.getClientRects().length);
      },
      destroy() {
        instances.delete(api);
        if (lastUsed === api) lastUsed = null;
        if (observer) observer.disconnect();
        if (classObserver) classObserver.disconnect();
        document.removeEventListener('mousedown', closeMenu);
        if (!isTA) {
          ignoreMutations = true;
          clearMarks();
        }
        if (wrap) {
          wrap.parentNode.insertBefore(target, wrap);
          wrap.remove();
        } else {
          bar.remove();
        }
      },
    };
    instances.add(api);
    return api;
  }

  // Focus the search bar for the editor the user is working in: the one
  // containing focus, else the last one used if visible, else the first
  // visible one. Returns true if a bar was focused.
  function focusActive() {
    const ae = document.activeElement;
    const list = Array.from(instances).filter((i) => i.visible());
    const pick =
      list.find((i) => ae && i.root.contains(ae)) ||
      (lastUsed && list.includes(lastUsed) ? lastUsed : null) ||
      list[0];
    if (!pick) return false;
    pick.focus();
    return true;
  }

  window.MsgSearch = { attach, focusActive, findAll };
})();
