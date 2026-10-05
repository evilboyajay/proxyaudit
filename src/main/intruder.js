'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { sendRequest } = require('./proxy/repeater');

/** Hard cap on how many payloads a single set may generate/retain. */
const PAYLOAD_CAP = 100000;
/** Sentinel returned by a processing rule to drop the payload entirely. */
const DROP = Symbol('intruder-drop-payload');

/**
 * Intruder — automated request fuzzing with payload positions, in the spirit of
 * Burp Suite's Intruder tab.
 *
 * A raw request template carries payload positions marked by a pair of § (section
 * sign) characters, e.g.  `GET /item?id=§1§ HTTP/1.1`. The text between each pair
 * is the default/placeholder for that position. Four classic attack types decide
 * how payloads are mapped onto the positions:
 *
 *   sniper        one set, one position changed at a time (others keep defaults)
 *   batteringram  one set, the same payload placed in every position at once
 *   pitchfork     N sets, advanced in lockstep (set i -> position i)
 *   clusterbomb   N sets, full cartesian product across positions
 *
 * Each generated request is sent with the shared repeater sendRequest(), and a
 * result row is emitted as it completes. Full request/response pairs are retained
 * (capped) so a detail view can fetch them on demand.
 *
 * Events:
 *   'status'            (state)                      — attack started/finished/stopped
 *   'error'             (message)
 *   'intruder-progress' { attackId, done, total }
 *   'intruder-result'   { attackId, row }            — row is a light summary
 *   'intruder-done'     { attackId, total, done, stopped }
 */
class Intruder extends EventEmitter {
  constructor({ maxRows = 50000 } = {}) {
    super();
    this.maxRows = maxRows;
    this.attacks = new Map(); // attackId -> attack record
    this._seq = 0;
  }

  // --------------------------- template parsing ---------------------------

  /**
   * Split a raw template into literal chunks and payload positions.
   * Returns { chunks:[literal,...], positions:[{ index, default }] }.
   * chunks and positions interleave: chunks[0] pos[0] chunks[1] pos[1] ... chunks[n].
   * An unpaired § is tolerated by treating the trailing text as a literal.
   */
  static parseTemplate(template) {
    const src = String(template == null ? '' : template).replace(/\r\n/g, '\n');
    const segs = src.split('§');
    // n § chars -> n+1 segments; well-formed templates have an odd segment count.
    const chunks = [];
    const positions = [];
    for (let i = 0; i < segs.length; i++) {
      if (i % 2 === 0) {
        chunks.push(segs[i]);
      } else {
        positions.push({ index: positions.length, default: segs[i] });
      }
    }
    // If a § was left unpaired, fold the dangling default back into the literal
    // stream so substitution still reconstructs the original text.
    if (segs.length % 2 === 0 && positions.length) {
      const dangling = positions.pop();
      chunks[chunks.length - 1] += '§' + dangling.default;
    }
    return { chunks, positions };
  }

  /** Reassemble a template, placing `values[i]` into position i. */
  static substitute(parsed, values) {
    const { chunks } = parsed;
    let out = chunks[0] || '';
    for (let i = 1; i < chunks.length; i++) {
      const v = values[i - 1];
      out += (v == null ? '' : String(v)) + chunks[i];
    }
    return out;
  }

  /**
   * Split a substituted raw request into { method, path, headers, body }.
   * Mirrors the renderer's parseRawRequest so behaviour is consistent.
   */
  static splitRequest(raw) {
    const text = String(raw).replace(/\r\n/g, '\n');
    const idx = text.indexOf('\n\n');
    const head = idx >= 0 ? text.slice(0, idx) : text;
    const body = idx >= 0 ? text.slice(idx + 2) : '';
    const lines = head.split('\n');
    const reqLine = lines.shift() || '';
    const parts = reqLine.trim().split(/\s+/);
    const method = parts[0] || 'GET';
    const path = parts[1] || '/';
    const headers = {};
    lines.forEach((line) => {
      const c = line.indexOf(':');
      if (c > 0) headers[line.slice(0, c).trim()] = line.slice(c + 1).trim();
    });
    return { method, path, headers, body };
  }

  // --------------------------- payload system ---------------------------

  /**
   * Turn a payload-set description into the concrete list of strings it yields.
   *
   * A set is EITHER a plain array of strings (legacy shape — used verbatim) OR a
   * config object:
   *
   *   { type, params, processing:[rules], encoding:{ chars } }
   *
   * `type` picks a generator (simple-list, numbers, dates, brute-forcer,
   * null-payloads, case-modification). Each generated payload is then passed
   * through the enabled `processing` rules in order, and finally the characters
   * listed in `encoding.chars` are percent-encoded. Rules may drop a payload
   * (skip-if-match), so the returned length can be smaller than the raw count.
   *
   * Always returns a (capped) array of strings.
   */
  static buildPayloads(config) {
    // Legacy: a bare array is a literal list, no processing/encoding.
    if (Array.isArray(config)) {
      const out = config.slice(0, PAYLOAD_CAP).map((s) => String(s == null ? '' : s));
      return out;
    }
    if (!config || typeof config !== 'object') return [];

    const type = config.type || 'simple-list';
    const params = config.params || {};
    const processing = Array.isArray(config.processing) ? config.processing : [];
    const encChars = config.encoding && config.encoding.chars ? String(config.encoding.chars) : '';

    const base = Intruder._generate(type, params);
    const out = [];
    for (let i = 0; i < base.length; i++) {
      let val = String(base[i]);
      let dropped = false;
      for (const rule of processing) {
        if (!rule || rule.enabled === false) continue;
        const r = Intruder._applyRule(rule, val);
        if (r === DROP) { dropped = true; break; }
        val = r;
      }
      if (dropped) continue;
      if (encChars) val = Intruder._encodeChars(val, encChars);
      out.push(val);
      if (out.length >= PAYLOAD_CAP) break;
    }
    return out;
  }

  /** Dispatch to a generator by type. Always returns a capped array of strings. */
  static _generate(type, params) {
    const p = params || {};
    switch (type) {
      case 'simple-list': {
        let items = p.items;
        if (typeof items === 'string') items = items.split('\n');
        if (!Array.isArray(items)) items = [];
        return items.slice(0, PAYLOAD_CAP).map((s) => String(s == null ? '' : s));
      }

      case 'numbers': {
        const from = Number(p.from);
        const to = Number(p.to);
        let step = Number(p.step);
        if (!isFinite(from) || !isFinite(to)) return [];
        if (!isFinite(step) || step === 0) step = 1;
        step = Math.abs(step);
        // Decimal precision of the step, so 0.1 increments don't drift.
        const dec = (String(p.step).split('.')[1] || '').length;
        const fmt = (n) => Intruder._formatNumber(n, p.format, dec);
        const out = [];
        if (from <= to) {
          for (let n = from; n <= to + 1e-9 && out.length < PAYLOAD_CAP; n += step) out.push(fmt(n));
        } else {
          for (let n = from; n >= to - 1e-9 && out.length < PAYLOAD_CAP; n -= step) out.push(fmt(n));
        }
        return out;
      }

      case 'dates': {
        const start = Intruder._parseDate(p.from);
        const end = Intruder._parseDate(p.to);
        let stepDays = Number(p.stepDays);
        if (!start || !end) return [];
        if (!isFinite(stepDays) || stepDays === 0) stepDays = 1;
        stepDays = Math.abs(stepDays);
        const fmt = p.format || 'YYYY-MM-DD';
        const out = [];
        const ms = stepDays * 86400000;
        if (start.getTime() <= end.getTime()) {
          for (let t = start.getTime(); t <= end.getTime() && out.length < PAYLOAD_CAP; t += ms)
            out.push(Intruder._formatDate(new Date(t), fmt));
        } else {
          for (let t = start.getTime(); t >= end.getTime() && out.length < PAYLOAD_CAP; t -= ms)
            out.push(Intruder._formatDate(new Date(t), fmt));
        }
        return out;
      }

      case 'brute-forcer': {
        const charset = String(p.charset || '');
        const chars = Array.from(charset);
        const minLen = Math.max(0, Number(p.minLen) || 0);
        const maxLen = Math.max(minLen, Number(p.maxLen) || minLen);
        if (!chars.length) return [];
        const out = [];
        for (let len = minLen; len <= maxLen; len++) {
          if (len === 0) { out.push(''); continue; }
          const counters = new Array(len).fill(0);
          while (out.length < PAYLOAD_CAP) {
            out.push(counters.map((c) => chars[c]).join(''));
            // odometer, last position fastest
            let i = len - 1;
            while (i >= 0) {
              counters[i]++;
              if (counters[i] < chars.length) break;
              counters[i] = 0;
              i--;
            }
            if (i < 0) break;
          }
          if (out.length >= PAYLOAD_CAP) break;
        }
        return out;
      }

      case 'null-payloads': {
        const count = Math.max(0, Math.min(PAYLOAD_CAP, Number(p.count) || 0));
        return new Array(count).fill('');
      }

      case 'case-modification': {
        let items = p.items;
        if (typeof items === 'string') items = items.split('\n');
        if (!Array.isArray(items)) items = [];
        const mode = p.mode || 'all';
        const out = [];
        for (const raw of items) {
          const s = String(raw == null ? '' : raw);
          if (mode === 'all') {
            const variants = [s, s.toLowerCase(), s.toUpperCase(), Intruder._capitalize(s)];
            for (const v of variants) if (!out.includes(v)) out.push(v);
          } else {
            out.push(Intruder._applyCase(s, mode));
          }
          if (out.length >= PAYLOAD_CAP) break;
        }
        return out.slice(0, PAYLOAD_CAP);
      }

      default:
        return [];
    }
  }

  // ------------------- processing rules & encoders -------------------

  /** Apply one processing rule. Returns the new string or the DROP sentinel. */
  static _applyRule(rule, val) {
    // Rule fields may sit on `rule` directly or under `rule.params`.
    const p = rule.params && typeof rule.params === 'object' ? rule.params : rule;
    switch (rule.type) {
      case 'add-prefix':
        return String(p.text == null ? '' : p.text) + val;
      case 'add-suffix':
        return val + String(p.text == null ? '' : p.text);
      case 'match-replace': {
        let re;
        try { re = new RegExp(p.regex, p.flags == null ? 'g' : p.flags); }
        catch (_) { return val; }
        return val.replace(re, p.replace == null ? '' : String(p.replace));
      }
      case 'substring': {
        const from = Number(p.from) || 0;
        if (p.length == null || p.length === '') return val.slice(from);
        return val.slice(from, from + Number(p.length));
      }
      case 'modify-case':
        return Intruder._applyCase(val, p.mode);
      case 'encode':
        return Intruder._encode(val, p.kind);
      case 'decode':
        return Intruder._decode(val, p.kind);
      case 'hash': {
        const algo = String(p.algo || 'sha256').toLowerCase();
        if (!['md5', 'sha1', 'sha256'].includes(algo)) return val;
        return crypto.createHash(algo).update(val, 'utf8').digest('hex');
      }
      case 'skip-if-match': {
        let re;
        try { re = new RegExp(p.regex, p.flags || ''); }
        catch (_) { return val; }
        return re.test(val) ? DROP : val;
      }
      default:
        return val;
    }
  }

  static _applyCase(s, mode) {
    switch (mode) {
      case 'lower': return s.toLowerCase();
      case 'upper': return s.toUpperCase();
      case 'capitalize': return Intruder._capitalize(s);
      default: return s;
    }
  }

  static _capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s;
  }

  static _encode(val, kind) {
    switch (kind) {
      case 'url':
        return encodeURIComponent(val);
      case 'url-all': {
        let out = '';
        for (const b of Buffer.from(val, 'utf8'))
          out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
        return out;
      }
      case 'base64':
        return Buffer.from(val, 'utf8').toString('base64');
      case 'html':
        return val.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      default:
        return val;
    }
  }

  static _decode(val, kind) {
    try {
      switch (kind) {
        case 'url': return decodeURIComponent(val);
        case 'base64': return Buffer.from(val, 'base64').toString('utf8');
        default: return val;
      }
    } catch (_) {
      return val;
    }
  }

  /** Percent-encode (UTF-8) only the characters that appear in `chars`. */
  static _encodeChars(val, chars) {
    const set = new Set(Array.from(String(chars)));
    if (!set.size) return val;
    let out = '';
    for (const ch of String(val)) {
      if (set.has(ch)) {
        for (const b of Buffer.from(ch, 'utf8'))
          out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      } else {
        out += ch;
      }
    }
    return out;
  }

  // ------------------------- number/date helpers -------------------------

  static _formatNumber(n, format, dec) {
    if (format === 'hex' || format === 'HEX') {
      const h = Math.round(n).toString(16);
      return format === 'HEX' ? h.toUpperCase() : h;
    }
    let s = dec > 0 ? n.toFixed(dec) : String(Math.round(n));
    // A format of zeros (e.g. "0000") or a digit count pads the integer part.
    let pad = 0;
    if (typeof format === 'number') pad = format;
    else if (typeof format === 'string' && /^0+$/.test(format)) pad = format.length;
    if (pad > 0) {
      const neg = s.startsWith('-');
      if (neg) s = s.slice(1);
      const dot = s.indexOf('.');
      const intPart = dot >= 0 ? s.slice(0, dot) : s;
      const rest = dot >= 0 ? s.slice(dot) : '';
      s = (neg ? '-' : '') + intPart.padStart(pad, '0') + rest;
    }
    return s;
  }

  static _parseDate(v) {
    if (v == null || v === '') return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  static _formatDate(d, fmt) {
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    return String(fmt)
      .replace(/YYYY/g, pad(d.getFullYear(), 4))
      .replace(/MM/g, pad(d.getMonth() + 1))
      .replace(/DD/g, pad(d.getDate()))
      .replace(/HH/g, pad(d.getHours()))
      .replace(/mm/g, pad(d.getMinutes()))
      .replace(/ss/g, pad(d.getSeconds()));
  }

  // --------------------------- counting / planning ---------------------------

  /**
   * Total number of requests an attack will produce. `positions` may be the
   * parsed positions array or just its length. Safe against missing sets.
   */
  countRequests(attackType, positions, payloadSets) {
    const n = Array.isArray(positions) ? positions.length : Number(positions) || 0;
    // Accept legacy arrays or config objects; build so generated/processed
    // counts (and skip-if-match drops) are reflected accurately.
    const sets = (payloadSets || []).map((s) => Intruder.buildPayloads(s));
    const len = (i) => (Array.isArray(sets[i]) ? sets[i].length : 0);
    switch (attackType) {
      case 'sniper':
        return n * len(0);
      case 'batteringram':
        return len(0);
      case 'pitchfork': {
        if (!n) return 0;
        let min = Infinity;
        for (let i = 0; i < n; i++) min = Math.min(min, len(i));
        return min === Infinity ? 0 : min;
      }
      case 'clusterbomb': {
        if (!n) return 0;
        let prod = 1;
        for (let i = 0; i < n; i++) prod *= len(i);
        return prod;
      }
      default:
        return 0;
    }
  }

  /**
   * Lazily yield { index, values:[perPosition], payloads:[displayed], position }.
   * `values` is what gets substituted into every position; `payloads` is what is
   * shown in the results table (the single injected payload for sniper/ram, or the
   * full tuple for pitchfork/clusterbomb). `position` is the targeted index for
   * sniper, otherwise null.
   */
  *_combos(attackType, positions, payloadSets) {
    const n = positions.length;
    const defaults = positions.map((p) => p.default);
    const sets = payloadSets || [];
    let index = 0;

    if (attackType === 'sniper') {
      const set = sets[0] || [];
      for (let pos = 0; pos < n; pos++) {
        for (const p of set) {
          const values = defaults.slice();
          values[pos] = p;
          yield { index: index++, values, payloads: [p], position: pos };
        }
      }
      return;
    }

    if (attackType === 'batteringram') {
      const set = sets[0] || [];
      for (const p of set) {
        const values = new Array(n).fill(p);
        yield { index: index++, values, payloads: [p], position: null };
      }
      return;
    }

    if (attackType === 'pitchfork') {
      let min = Infinity;
      for (let i = 0; i < n; i++) min = Math.min(min, (sets[i] || []).length);
      if (min === Infinity) min = 0;
      for (let k = 0; k < min; k++) {
        const values = [];
        for (let i = 0; i < n; i++) values.push(sets[i][k]);
        yield { index: index++, values, payloads: values.slice(), position: null };
      }
      return;
    }

    if (attackType === 'clusterbomb') {
      if (!n) return;
      const lens = positions.map((_, i) => (sets[i] || []).length);
      if (lens.some((l) => l === 0)) return;
      const counters = new Array(n).fill(0);
      while (true) {
        const values = counters.map((c, i) => sets[i][c]);
        yield { index: index++, values, payloads: values.slice(), position: null };
        // odometer increment, least-significant position (last) fastest
        let i = n - 1;
        while (i >= 0) {
          counters[i]++;
          if (counters[i] < lens[i]) break;
          counters[i] = 0;
          i--;
        }
        if (i < 0) break;
      }
      return;
    }
  }

  // ------------------------------- running -------------------------------

  /**
   * Begin an attack. Returns quickly with { attackId, total, positions } while the
   * worker pool runs in the background and streams events. Reuse the caller's
   * attackId or omit it to have one generated.
   */
  start({
    attackId,
    origin,
    template,
    attackType = 'sniper',
    payloadSets = [],
    headersBaseline = {},
    concurrency = 10,
    timeoutMs = 30000,
  } = {}) {
    const id = attackId || `atk-${Date.now()}-${++this._seq}`;
    const parsed = Intruder.parseTemplate(template);
    const positions = parsed.positions;
    // Resolve each set (array or config object) to a concrete payload list once,
    // so generation/processing/encoding runs a single time for the whole attack.
    const resolvedSets = (payloadSets || []).map((s) => Intruder.buildPayloads(s));
    const total = this.countRequests(attackType, positions, resolvedSets);

    const attack = {
      id,
      origin: String(origin || '').replace(/\/+$/, ''),
      parsed,
      positions,
      attackType,
      payloadSets: resolvedSets,
      headersBaseline: headersBaseline || {},
      timeoutMs,
      concurrency: Math.max(1, Number(concurrency) || 10),
      total,
      done: 0,
      stopped: false,
      finished: false,
      rows: new Map(), // index -> full { payloads, position, request, response, ... }
      startedAt: Date.now(),
    };
    this.attacks.set(id, attack);
    this.emit('status', this.state());

    // Fire-and-forget; the pool reports progress through events.
    this._run(attack).catch((e) => this.emit('error', 'Intruder: ' + e.message));

    return { attackId: id, total, positions: positions.length, attackType };
  }

  async _run(attack) {
    const gen = this._combos(attack.attackType, attack.positions, attack.payloadSets);
    const worker = async () => {
      while (!attack.stopped) {
        const next = gen.next();
        if (next.done) break;
        const job = next.value;
        await this._execute(attack, job);
      }
    };
    const pool = [];
    for (let i = 0; i < attack.concurrency; i++) pool.push(worker());
    await Promise.all(pool);

    attack.finished = true;
    this.emit('intruder-progress', {
      attackId: attack.id,
      done: attack.done,
      total: attack.total,
    });
    this.emit('intruder-done', {
      attackId: attack.id,
      total: attack.total,
      done: attack.done,
      stopped: attack.stopped,
    });
    this.emit('status', this.state());
  }

  async _execute(attack, job) {
    const raw = Intruder.substitute(attack.parsed, job.values);
    const { method, path, headers, body } = Intruder.splitRequest(raw);
    const url = attack.origin + (path.startsWith('/') ? path : '/' + path);
    // Baseline headers are defaults; headers parsed from the template win.
    const mergedHeaders = { ...attack.headersBaseline, ...headers };

    const request = {
      method,
      url,
      headers: mergedHeaders,
      body: body && body.length ? body : null,
    };

    const res = await sendRequest({
      method,
      url,
      headers: mergedHeaders,
      body: request.body,
      timeoutMs: attack.timeoutMs,
    });

    // If the attack was stopped mid-flight, drop the straggler quietly.
    if (attack.stopped) return;

    const row = {
      index: job.index,
      payloads: job.payloads,
      position: job.position,
      status: res.error ? null : res.status,
      length: res.error ? null : res.length,
      durationMs: res.durationMs != null ? res.durationMs : null,
      error: res.error || null,
      mime: res.error ? '' : res.mime || '',
    };

    if (attack.rows.size < this.maxRows) {
      attack.rows.set(job.index, { ...row, request, response: res });
    }

    attack.done += 1;
    this.emit('intruder-result', { attackId: attack.id, row });
    if (attack.done % 20 === 0 || attack.done === attack.total) {
      this.emit('intruder-progress', {
        attackId: attack.id,
        done: attack.done,
        total: attack.total,
      });
    }
  }

  /** Abort an in-flight attack. Workers stop pulling; stragglers are discarded. */
  stop(attackId) {
    const attack = this.attacks.get(attackId);
    if (!attack) return false;
    attack.stopped = true;
    return true;
  }

  /** Full request/response for one row, for a detail pane. */
  getResult(attackId, index) {
    const attack = this.attacks.get(attackId);
    if (!attack) return null;
    const full = attack.rows.get(Number(index));
    if (!full) return null;
    return {
      index: full.index,
      payloads: full.payloads,
      position: full.position,
      request: full.request,
      response: full.response,
    };
  }

  /** Light summaries of every stored row (for rehydrating a results table). */
  listResults(attackId) {
    const attack = this.attacks.get(attackId);
    if (!attack) return [];
    return Array.from(attack.rows.values())
      .map((r) => ({
        index: r.index,
        payloads: r.payloads,
        position: r.position,
        status: r.status,
        length: r.length,
        durationMs: r.durationMs,
        error: r.error,
        mime: r.mime,
      }))
      .sort((a, b) => a.index - b.index);
  }

  state() {
    return {
      attacks: Array.from(this.attacks.values()).map((a) => ({
        attackId: a.id,
        attackType: a.attackType,
        total: a.total,
        done: a.done,
        stopped: a.stopped,
        finished: a.finished,
        positions: a.positions.length,
        rows: a.rows.size,
      })),
    };
  }

  /** Drop a stored attack's data. */
  remove(attackId) {
    return this.attacks.delete(attackId);
  }
}

module.exports = { Intruder };
