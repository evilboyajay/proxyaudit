'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SCOPE_DIR = path.join(os.homedir(), '.proxyaudit');
const SCOPE_PATH = path.join(SCOPE_DIR, 'scope.json');

/**
 * Target-scope manager (like Burp's scope). Holds include/exclude host rules
 * and decides whether a URL is "in scope". Rules persist to
 * ~/.proxyaudit/scope.json so a session's scope survives restarts.
 *
 * Rule shape: { id, enabled, mode:'include'|'exclude', host, port?, pathPrefix? }
 *  - host  : matched case-insensitively. Supports:
 *              '*'                 => any host
 *              'example.com'       => exact, OR any subdomain (foo.example.com)
 *              '.example.com'      => subdomains only (leading dot)
 *              '*.example.com'     => subdomains only (wildcard)
 *              'api.*'             => prefix wildcard
 *              '*cdn*'             => arbitrary wildcard anywhere
 *  - port : optional. When set, must equal the URL's port (default 80/443).
 *  - pathPrefix : optional. When set, URL path must start with it.
 *
 * inScope(url): true when it matches an enabled include rule (or there are no
 * enabled include rules => everything is implicitly in scope) AND matches no
 * enabled exclude rule.
 *
 * Events: 'changed' (emitted after any mutation) — the host can forward this
 * to the renderer as 'evt:scope-changed'.
 */
class Scope extends EventEmitter {
  constructor(file = SCOPE_PATH) {
    super();
    this.file = file;
    this.rules = [];
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) this.rules = raw.filter((r) => r && r.host);
      else if (raw && Array.isArray(raw.rules)) this.rules = raw.rules.filter((r) => r && r.host);
    } catch (_) {
      this.rules = [];
    }
    // Normalise any rules read from disk.
    this.rules = this.rules.map((r) => this._normalize(r));
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ rules: this.rules }, null, 2));
    } catch (_) {
      /* best effort; scope still works in memory */
    }
  }

  _normalize(r) {
    const rule = {
      id: r.id || crypto.randomBytes(6).toString('hex'),
      enabled: r.enabled !== false,
      mode: r.mode === 'exclude' ? 'exclude' : 'include',
      host: String(r.host || '').trim().toLowerCase(),
    };
    const port = Number(r.port);
    if (Number.isFinite(port) && port > 0) rule.port = port;
    const pp = String(r.pathPrefix || '').trim();
    if (pp) rule.pathPrefix = pp;
    return rule;
  }

  // ---- queries -------------------------------------------------------------

  list() {
    return this.rules.map((r) => ({ ...r }));
  }

  /** Compile a host pattern into a predicate over a lowercased hostname. */
  _hostMatches(pattern, host) {
    if (!pattern || pattern === '*') return true;
    // Leading-dot => subdomain-only suffix match.
    if (pattern.startsWith('.')) {
      const suffix = pattern.slice(1);
      return host === suffix || host.endsWith('.' + suffix);
    }
    if (pattern.includes('*')) {
      // '*.example.com' behaves like a subdomain-only match (Burp-style),
      // other wildcards become a general glob.
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        return host === suffix || host.endsWith('.' + suffix);
      }
      const rx = new RegExp(
        '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'
      );
      return rx.test(host);
    }
    // Plain host: exact match or any subdomain of it (Burp default).
    return host === pattern || host.endsWith('.' + pattern);
  }

  _ruleMatches(rule, parsed) {
    if (!rule.enabled) return false;
    if (!this._hostMatches(rule.host, parsed.host)) return false;
    if (rule.port && Number(parsed.port) !== rule.port) return false;
    if (rule.pathPrefix && !parsed.path.startsWith(rule.pathPrefix)) return false;
    return true;
  }

  _parse(urlString) {
    try {
      const u = new URL(urlString);
      const port = u.port
        ? Number(u.port)
        : u.protocol === 'https:'
          ? 443
          : u.protocol === 'http:'
            ? 80
            : 0;
      return { host: u.hostname.toLowerCase(), port, path: u.pathname + u.search };
    } catch (_) {
      return null;
    }
  }

  inScope(urlString) {
    const parsed = this._parse(urlString);
    if (!parsed) return false;

    const includes = this.rules.filter((r) => r.enabled && r.mode === 'include');
    const excludes = this.rules.filter((r) => r.enabled && r.mode === 'exclude');

    // No include rules => everything is in scope (subject to excludes).
    const included =
      includes.length === 0 || includes.some((r) => this._ruleMatches(r, parsed));
    if (!included) return false;

    if (excludes.some((r) => this._ruleMatches(r, parsed))) return false;
    return true;
  }

  // ---- mutations -----------------------------------------------------------

  add(rule) {
    const normalized = this._normalize(rule || {});
    if (!normalized.host) return { error: 'host is required' };
    this.rules.push(normalized);
    this._save();
    this.emit('changed', this.list());
    return normalized;
  }

  remove(id) {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    const removed = this.rules.length !== before;
    if (removed) {
      this._save();
      this.emit('changed', this.list());
    }
    return removed;
  }

  setEnabled(id, enabled) {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) return false;
    rule.enabled = !!enabled;
    this._save();
    this.emit('changed', this.list());
    return true;
  }

  clear() {
    this.rules = [];
    this._save();
    this.emit('changed', this.list());
  }
}

module.exports = { Scope, SCOPE_PATH };
