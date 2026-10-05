'use strict';

/**
 * DiffUtil — pure, dependency-free LCS text diffing for the Comparer tab.
 *
 * Browser-safe: attaches to window.DiffUtil. Also exports under
 * module.exports when running in Node (used for the throwaway test), without
 * assuming either environment exists.
 *
 * The core is a standard longest-common-subsequence (LCS) diff over an array
 * of tokens. Line mode tokenises on newlines (keeping the newline with its
 * line); word mode tokenises on runs of whitespace vs non-whitespace so that
 * spacing is preserved verbatim. Both return a flat array of segments:
 *
 *   { type: 'eq' | 'del' | 'ins', text: string }
 *
 * 'eq'  = present in both A and B
 * 'del' = present only in A (removed)
 * 'ins' = present only in B (added)
 */
(function (global) {
  // --------------------------- tokenisers ---------------------------

  // Split into lines, keeping each trailing "\n" attached to its line so that
  // joining the tokens reproduces the original string exactly.
  function tokenizeLines(text) {
    const str = String(text == null ? '' : text);
    if (str === '') return [];
    const tokens = [];
    let start = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\n') {
        tokens.push(str.slice(start, i + 1));
        start = i + 1;
      }
    }
    if (start < str.length) tokens.push(str.slice(start));
    return tokens;
  }

  // Split into alternating runs of whitespace and non-whitespace. Joining the
  // tokens reproduces the original string exactly.
  function tokenizeWords(text) {
    const str = String(text == null ? '' : text);
    if (str === '') return [];
    const tokens = str.match(/\s+|\S+/g);
    return tokens || [];
  }

  // ------------------------------ LCS -------------------------------

  // Classic dynamic-programming LCS over two token arrays, returning the
  // diff as an ordered list of { type, tokens } groups. We build the DP table
  // of common-subsequence lengths then backtrack.
  function lcsDiff(a, b) {
    const n = a.length;
    const m = b.length;

    // dp[i][j] = LCS length of a[i..] and b[j..]. Size (n+1) x (m+1).
    // Use a flat typed-friendly structure of rows for clarity.
    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Int32Array(m + 1);

    for (let i = n - 1; i >= 0; i--) {
      const ai = a[i];
      const dpi = dp[i];
      const dpi1 = dp[i + 1];
      for (let j = m - 1; j >= 0; j--) {
        if (ai === b[j]) dpi[j] = dpi1[j + 1] + 1;
        else dpi[j] = dpi1[j] >= dpi[j + 1] ? dpi1[j] : dpi[j + 1];
      }
    }

    // Backtrack from (0,0) producing raw per-token ops, then coalesce runs.
    const ops = []; // { type, text }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        ops.push({ type: 'eq', text: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: 'del', text: a[i] });
        i++;
      } else {
        ops.push({ type: 'ins', text: b[j] });
        j++;
      }
    }
    while (i < n) {
      ops.push({ type: 'del', text: a[i] });
      i++;
    }
    while (j < m) {
      ops.push({ type: 'ins', text: b[j] });
      j++;
    }
    return ops;
  }

  // Merge adjacent ops of the same type into single segments so consumers get
  // compact output (e.g. one 'eq' segment per contiguous common block).
  function coalesce(ops) {
    const out = [];
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      if (op.text === '') continue;
      const last = out[out.length - 1];
      if (last && last.type === op.type) last.text += op.text;
      else out.push({ type: op.type, text: op.text });
    }
    return out;
  }

  // ----------------------------- public -----------------------------

  /**
   * Diff two strings. Returns an array of { type:'eq'|'del'|'ins', text }.
   * @param {string} a  "old" / left / slot A
   * @param {string} b  "new" / right / slot B
   * @param {'line'|'word'} [mode='line']
   */
  function diff(a, b, mode) {
    const tokenize = mode === 'word' ? tokenizeWords : tokenizeLines;
    return coalesce(lcsDiff(tokenize(a), tokenize(b)));
  }

  // Convenience wrappers.
  function diffLines(a, b) {
    return diff(a, b, 'line');
  }
  function diffWords(a, b) {
    return diff(a, b, 'word');
  }

  /**
   * Summary counts for a segment list: tokens/chars added, removed, equal.
   */
  function stats(segments) {
    const s = { eq: 0, del: 0, ins: 0 };
    for (const seg of segments) s[seg.type] += seg.text.length;
    return s;
  }

  const DiffUtil = {
    diff,
    diffLines,
    diffWords,
    tokenizeLines,
    tokenizeWords,
    stats,
  };

  // Attach to the browser window (CSP-safe, no inline script needed).
  if (typeof global !== 'undefined') global.DiffUtil = DiffUtil;
  // Allow require() in Node for testing.
  if (typeof module !== 'undefined' && module.exports) module.exports = DiffUtil;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
