'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Burp-style proxy Match & Replace.
 *
 * Holds an ordered list of rules and rewrites parts of requests/responses as
 * they pass through the proxy. Each rule targets one part of a message:
 *
 *   part:      'req-header' | 'req-body' | 'req-firstline'
 *              'res-header' | 'res-body' | 'res-status'
 *   matchType: 'string' (literal) | 'regex' (JS RegExp, applied with the 'g' flag)
 *   match:     the text/pattern to find (empty match on a *-header rule ADDS the
 *              `replace` text as a new header line)
 *   replace:   the replacement text (for regex, $1.. backrefs work)
 *
 * Rules apply in list order; only `enabled` rules run. Header rules operate on
 * the serialized "Name: value" lines so a pattern can span the name and value.
 *
 * Rules persist to ~/.proxyaudit/matchreplace.json — loaded on construction,
 * saved on every mutation.
 */
const PARTS = [
  'req-header',
  'req-body',
  'req-firstline',
  'res-header',
  'res-body',
  'res-status',
];

class MatchReplace {
  constructor(options = {}) {
    this.dir = options.dir || path.join(os.homedir(), '.proxyaudit');
    this.filePath = options.filePath || path.join(this.dir, 'matchreplace.json');
    this.rules = [];
    this._load();
  }

  // ----------------------------- store -----------------------------
  _nextId() {
    return `r${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  }

  _normalize(rule = {}) {
    return {
      id: rule.id || this._nextId(),
      enabled: rule.enabled !== false,
      name: rule.name != null && String(rule.name).trim() ? String(rule.name) : 'Rule',
      part: PARTS.includes(rule.part) ? rule.part : 'req-header',
      matchType: rule.matchType === 'regex' ? 'regex' : 'string',
      match: rule.match != null ? String(rule.match) : '',
      replace: rule.replace != null ? String(rule.replace) : '',
      comment: rule.comment != null ? String(rule.comment) : '',
    };
  }

  list() {
    return this.rules.map((r) => ({ ...r }));
  }

  add(rule) {
    const r = this._normalize(rule);
    this.rules.push(r);
    this._save();
    return { ...r };
  }

  update(id, patch = {}) {
    const r = this.rules.find((x) => x.id === id);
    if (!r) return null;
    const next = this._normalize({ ...r, ...patch, id: r.id });
    Object.assign(r, next);
    this._save();
    return { ...r };
  }

  remove(id) {
    const i = this.rules.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.rules.splice(i, 1);
    this._save();
    return true;
  }

  setEnabled(id, enabled) {
    const r = this.rules.find((x) => x.id === id);
    if (!r) return null;
    r.enabled = !!enabled;
    this._save();
    return { ...r };
  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (Array.isArray(data)) this.rules = data.map((r) => this._normalize(r));
    } catch (_) {
      /* no file yet, or unreadable — start empty */
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.rules, null, 2));
    } catch (_) {
      /* best-effort persistence */
    }
  }

  // ----------------------------- apply -----------------------------
  /**
   * Substitute within a single string per one rule. Literal matches replace
   * every occurrence; regex matches use the 'g' flag. An empty match or an
   * invalid regex is a no-op (returns the input unchanged).
   */
  _applyString(str, rule) {
    const input = str == null ? '' : String(str);
    const match = rule.match != null ? String(rule.match) : '';
    const replace = rule.replace != null ? String(rule.replace) : '';
    if (!match) return input;
    if (rule.matchType === 'regex') {
      let re;
      try {
        re = new RegExp(match, 'g');
      } catch (_) {
        return input; // invalid pattern — skip rather than throw
      }
      return input.replace(re, replace);
    }
    // literal: replace all occurrences without regex interpretation
    return input.split(match).join(replace);
  }

  /**
   * Apply one header rule to a headers object. Headers are serialized to
   * "Name: value" lines (one per value, arrays expanded), the substitution is
   * run over that block, and the block is parsed back into an object. An empty
   * `match` appends `replace` as a new header line (Burp's "add header").
   */
  _applyHeaders(headers, rule) {
    const lines = [];
    for (const [k, v] of Object.entries(headers || {})) {
      if (Array.isArray(v)) v.forEach((x) => lines.push(`${k}: ${x}`));
      else lines.push(`${k}: ${v}`);
    }
    let block = lines.join('\n');

    const match = rule.match != null ? String(rule.match) : '';
    const replace = rule.replace != null ? String(rule.replace) : '';
    if (!match) {
      if (replace) block = block ? `${block}\n${replace}` : replace;
    } else {
      block = this._applyString(block, rule);
    }

    const out = {};
    block.split('\n').forEach((line) => {
      if (!line.trim()) return;
      const c = line.indexOf(':');
      if (c < 0) return;
      const key = line.slice(0, c).trim();
      if (!key) return;
      const val = line.slice(c + 1).trim();
      if (out[key] !== undefined) out[key] = [].concat(out[key], val);
      else out[key] = val;
    });
    return out;
  }

  /**
   * Run all enabled req-* rules. Returns a new, possibly-modified
   * {method, url, headers, body}. `url` is treated as the request target
   * (path) for the purposes of the 'req-firstline' part, which operates on the
   * "METHOD url" string.
   */
  applyRequest(req = {}) {
    let method = req.method;
    let url = req.url;
    let headers = req.headers ? { ...req.headers } : {};
    let body = req.body;

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      switch (rule.part) {
        case 'req-firstline': {
          const line = `${method == null ? '' : method} ${url == null ? '' : url}`;
          const out = this._applyString(line, rule);
          const sp = out.indexOf(' ');
          if (sp >= 0) {
            method = out.slice(0, sp);
            url = out.slice(sp + 1);
          } else {
            method = out;
            url = '';
          }
          break;
        }
        case 'req-header':
          headers = this._applyHeaders(headers, rule);
          break;
        case 'req-body':
          if (body != null) body = this._applyString(body, rule);
          break;
        default:
          break; // res-* rules ignored here
      }
    }
    return { method, url, headers, body };
  }

  /**
   * Run all enabled res-* rules. Returns a new, possibly-modified
   * {status, headers, body}.
   */
  applyResponse(res = {}) {
    let status = res.status;
    let headers = res.headers ? { ...res.headers } : {};
    let body = res.body;

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      switch (rule.part) {
        case 'res-status': {
          const out = this._applyString(status == null ? '' : status, rule);
          const n = parseInt(out, 10);
          status = Number.isNaN(n) ? status : n;
          break;
        }
        case 'res-header':
          headers = this._applyHeaders(headers, rule);
          break;
        case 'res-body':
          if (body != null) body = this._applyString(body, rule);
          break;
        default:
          break; // req-* rules ignored here
      }
    }
    return { status, headers, body };
  }
}

module.exports = { MatchReplace };
