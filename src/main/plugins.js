'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { URL } = require('url');
const { EventEmitter } = require('events');
const auditor = require('./audit/auditor');

/**
 * Plugin host — the "Build" workshop (like Burp's Extender).
 *
 * A plugin is JS that calls register({ name, onRequest?, onResponse? }). The
 * host compiles it in a vm sandbox, runs enabled plugins against live traffic
 * (and on demand over captured history), and surfaces findings + console
 * output. Plugins receive an `api` with log/finding/ai (Claude) helpers.
 *
 * Plugins run with the author's own privileges by design — this is a tool for
 * building your own security tooling, exactly like Burp extensions.
 *
 * Events: 'log' ({plugin, level, text}), 'finding' (finding), 'changed'
 */
const TEMPLATE = `// ProxyAudit plugin — runs against proxied traffic.
// Call register(...) once with your handlers.
register({
  name: 'Security headers',
  description: 'Flags responses missing common security headers.',

  // Called for each response (live, and when you click "Run on history").
  async onResponse(flow, api) {
    const h = flow.response.headers || {};
    const want = ['content-security-policy', 'x-content-type-options', 'strict-transport-security'];
    for (const name of want) {
      if (!h[name]) {
        api.finding({
          title: 'Missing ' + name,
          severity: 'Low',
          flowId: flow.id,
          detail: flow.method + ' ' + flow.url,
        });
      }
    }
  },

  // Optional: called for each request before it is forwarded.
  // async onRequest(flow, api) { api.log(flow.method, flow.url); },
});

// Tip: api.ai("prompt") asks Claude (your logged-in session) and returns text,
// so you can build AI-powered checks, e.g.:
//   const verdict = await api.ai('Is this response leaking secrets?\\n' + flow.response.body);
`;

class PluginHost extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dir = opts.dir || path.join(os.homedir(), '.proxyaudit', 'plugins');
    this.enabledFile = path.join(this.dir, '.enabled.json');
    this.compiled = new Map(); // name -> { def, code, file, error }
    this.enabled = new Set();
    this.findings = [];
    this._load();
  }

  _load() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.enabled = new Set(JSON.parse(fs.readFileSync(this.enabledFile, 'utf8')));
    } catch (_) {
      this.enabled = new Set();
    }
    this.compiled.clear();
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.js')) continue;
      const name = file.replace(/\.js$/, '');
      const code = fs.readFileSync(path.join(this.dir, file), 'utf8');
      try {
        const def = this._compile(code);
        this.compiled.set(name, { def, code, file, error: null });
      } catch (e) {
        this.compiled.set(name, { def: null, code, file, error: e.message });
      }
    }
  }

  _saveEnabled() {
    try {
      fs.writeFileSync(this.enabledFile, JSON.stringify([...this.enabled]));
    } catch (_) {
      /* ignore */
    }
  }

  /** Compile plugin code in a sandbox and return its registered definition. */
  _compile(code) {
    let def = null;
    const sandbox = {
      register: (d) => {
        if (!d || typeof d !== 'object') throw new Error('register() needs an object');
        def = d;
      },
      console: {
        log: (...a) => this.emit('log', { plugin: '(compile)', level: 'log', text: a.join(' ') }),
        error: (...a) => this.emit('log', { plugin: '(compile)', level: 'error', text: a.join(' ') }),
      },
      setTimeout, clearTimeout, URL, Buffer, atob, btoa,
      JSON, Math, Date, RegExp, encodeURIComponent, decodeURIComponent,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { timeout: 4000, filename: 'plugin.js' });
    if (!def) throw new Error('Plugin never called register({ ... })');
    if (!def.name) def.name = 'Unnamed plugin';
    return def;
  }

  _api(pluginName) {
    return {
      log: (...a) =>
        this.emit('log', { plugin: pluginName, level: 'log', text: a.map(String).join(' ') }),
      finding: (f) => {
        const finding = {
          id: this.findings.length + 1,
          ts: Date.now(),
          plugin: pluginName,
          title: f.title || 'Finding',
          severity: f.severity || 'Info',
          detail: f.detail || '',
          flowId: f.flowId || null,
        };
        this.findings.push(finding);
        if (this.findings.length > 5000) this.findings.shift();
        this.emit('finding', finding);
        return finding;
      },
      ai: (prompt, opts) => auditor.ask(String(prompt), opts || {}),
    };
  }

  async _runOne(name, def, flow, phase) {
    const fn = phase === 'request' ? def.onRequest : def.onResponse;
    if (typeof fn !== 'function') return;
    try {
      await fn(flow, this._api(name));
    } catch (e) {
      this.emit('log', { plugin: name, level: 'error', text: String(e && e.message ? e.message : e) });
    }
  }

  /** Live hook: called by the engine for each flow. */
  async process(flow, phase = 'response') {
    if (phase === 'response' && !flow.response) return;
    for (const [name, p] of this.compiled) {
      if (p.error || !this.enabled.has(name)) continue;
      await this._runOne(name, p.def, flow, phase);
    }
  }

  /** Run arbitrary editor code over a set of flows (the "Run" button). */
  async runCode(code, flows) {
    let def;
    try {
      def = this._compile(code);
    } catch (e) {
      this.emit('log', { plugin: '(editor)', level: 'error', text: 'Compile error: ' + e.message });
      return { ok: false, error: e.message };
    }
    this.emit('log', { plugin: def.name, level: 'log', text: `Running over ${flows.length} flow(s)…` });
    for (const flow of flows) {
      if (def.onRequest) await this._runOne(def.name, def, flow, 'request');
      if (flow.response && def.onResponse) await this._runOne(def.name, def, flow, 'response');
    }
    this.emit('log', { plugin: def.name, level: 'log', text: 'Done.' });
    return { ok: true, name: def.name };
  }

  // ---- management ----
  list() {
    return [...this.compiled.entries()].map(([name, p]) => ({
      name,
      enabled: this.enabled.has(name),
      error: p.error,
      description: p.def && p.def.description ? p.def.description : '',
    }));
  }
  read(name) {
    const p = this.compiled.get(name);
    return p ? p.code : null;
  }
  save(name, code) {
    const safe = String(name).replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'plugin';
    try {
      this._compile(code); // validate before saving
    } catch (e) {
      return { ok: false, error: e.message };
    }
    fs.writeFileSync(path.join(this.dir, safe + '.js'), code);
    this._load();
    this.emit('changed');
    return { ok: true, name: safe };
  }
  remove(name) {
    const p = this.compiled.get(name);
    if (p) {
      try { fs.unlinkSync(path.join(this.dir, p.file)); } catch (_) {}
    }
    this.enabled.delete(name);
    this._saveEnabled();
    this._load();
    this.emit('changed');
    return true;
  }
  setEnabled(name, on) {
    if (on) this.enabled.add(name);
    else this.enabled.delete(name);
    this._saveEnabled();
    this.emit('changed');
    return true;
  }
  template() {
    return TEMPLATE;
  }
  listFindings() {
    return this.findings;
  }
  clearFindings() {
    this.findings = [];
  }
}

module.exports = { PluginHost };
