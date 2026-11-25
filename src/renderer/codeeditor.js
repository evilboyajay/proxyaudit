'use strict';

/*
 * CodeEditor — turns a plain <textarea> into a Burp-style HTTP message
 * editor: line-number gutter, syntax colouring and a search bar, while the
 * textarea itself stays the source of truth (value, selection, undo, the
 * app's existing listeners and transforms all keep working).
 *
 * Browser-safe. Attaches window.CodeEditor. Needs httpcolor.js and
 * searchbar.js loaded first.
 *
 *   const ed = CodeEditor.attach(textarea);
 *   ed.refresh(); ed.search; ed.destroy();
 *
 * How it works: the textarea is made transparent (only its caret and
 * selection show) and laid over a "backdrop" that renders the same text,
 * coloured, one block per logical line. Line numbers are CSS-counter
 * pseudo-elements in the backdrop's left padding, so they wrap and scroll
 * exactly with the text. Both layers share font, padding and wrap width,
 * and the backdrop's scroll position follows the textarea's.
 */
(function () {
  function attach(ta, options = {}) {
    if (!ta || ta.tagName !== 'TEXTAREA') throw new Error('CodeEditor.attach: textarea required');

    const wrap = document.createElement('div');
    wrap.className = 'ce-wrap';
    const field = document.createElement('div');
    field.className = 'ce-field';
    const back = document.createElement('div');
    back.className = 'ce-back';
    back.setAttribute('aria-hidden', 'true');
    const lines = document.createElement('div');
    lines.className = 'ce-lines';
    back.appendChild(lines);

    ta.parentNode.insertBefore(wrap, ta);
    field.appendChild(back);
    field.appendChild(ta);
    wrap.appendChild(field);
    ta.classList.add('ce-ta');
    ta.setAttribute('wrap', 'soft');

    let hits = [];
    let current = -1;
    let scrollPending = false;

    function syncMetrics() {
      // Reserve the textarea's scrollbar width on the backdrop so both
      // layers wrap lines at exactly the same column.
      const sb = Math.max(0, ta.offsetWidth - ta.clientWidth);
      back.style.right = sb + 'px';
    }
    function syncScroll() {
      back.scrollTop = ta.scrollTop;
      back.scrollLeft = ta.scrollLeft;
    }

    function render() {
      const text = ta.value;
      const html = window.HttpColor.toLines(window.HttpColor.tokenize(text), hits, current);
      field.style.setProperty('--ln-digits', String(html.length).length);
      lines.innerHTML = html.map((l) => `<div class="ce-line">${l || '<br>'}</div>`).join('');
      syncMetrics();
      if (scrollPending) {
        scrollPending = false;
        const cur = lines.querySelector('mark.ms-cur');
        if (cur) {
          const top = cur.getBoundingClientRect().top - lines.getBoundingClientRect().top;
          if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - 24) {
            ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
          }
        }
      }
      syncScroll();
    }

    // Coalesce bursts of changes (typing, programmatic sets) into one paint.
    let queued = false;
    function schedule() {
      if (queued) return;
      queued = true;
      const run = () => {
        queued = false;
        render();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else Promise.resolve().then(run);
    }

    // Programmatic `.value = ...` (loading a Repeater tab, transforms,
    // intercept) doesn't fire `input`; intercept the setter on this element.
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    Object.defineProperty(ta, 'value', {
      configurable: true,
      get() {
        return proto.get.call(this);
      },
      set(v) {
        proto.set.call(this, v);
        changed();
      },
    });

    function changed() {
      if (search) search.contentChanged(); // search re-renders via setHits
      schedule();
    }
    const onInput = () => changed();
    const onScroll = () => syncScroll();
    ta.addEventListener('input', onInput);
    ta.addEventListener('scroll', onScroll);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        syncMetrics();
        syncScroll();
      });
      ro.observe(ta);
    }

    const editorApi = {
      // Called by MsgSearch with the current matches.
      setHits(h, cur, scroll) {
        hits = h || [];
        current = cur;
        if (scroll) scrollPending = true;
        render();
      },
    };
    const search = window.MsgSearch
      ? window.MsgSearch.attach(ta, { barHost: wrap, editor: editorApi })
      : null;

    render();

    return {
      wrap,
      search,
      refresh: render,
      destroy() {
        if (search) search.destroy();
        if (ro) ro.disconnect();
        ta.removeEventListener('input', onInput);
        ta.removeEventListener('scroll', onScroll);
        delete ta.value;
        ta.classList.remove('ce-ta');
        wrap.parentNode.insertBefore(ta, wrap);
        wrap.remove();
      },
    };
  }

  window.CodeEditor = { attach };
})();
