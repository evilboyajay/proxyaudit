'use strict';

const { EventEmitter } = require('events');
const { sendRequest } = require('./proxy/repeater');

/**
 * Burp-Sequencer-style token randomness analyzer.
 *
 * Repeatedly fires the SAME request a configurable number of times, extracts a
 * session token from each response (by header, cookie, regex or JSON path),
 * collects the tokens, and runs a statistical analysis to estimate how random
 * (unpredictable) they are. Useful for judging the quality of session ids,
 * CSRF tokens, password-reset tokens, and similar secrets.
 *
 * Tokens are held in memory keyed by jobId (capped) so the UI can inspect the
 * raw sample. The analysis computes per-character-position frequency tables,
 * Shannon entropy per position and overall, an estimated total bits of
 * entropy, token length stats, duplicate counts, and a plain verdict string.
 *
 * Events:
 *   'seq-progress' { jobId, collected, total }
 *   'seq-done'     { jobId, analysis }
 *   'status'       (state snapshot)
 *   'error'        (message)
 */

const MAX_TOKENS = 100000; // hard cap on tokens retained per job

class Sequencer extends EventEmitter {
  constructor() {
    super();
    // jobId -> { tokens:[], total, collected, running, stopped, errors, request, tokenSource }
    this.jobs = new Map();
  }

  state() {
    const jobs = {};
    for (const [id, j] of this.jobs) {
      jobs[id] = {
        collected: j.collected,
        total: j.total,
        running: j.running,
        stopped: j.stopped,
        errors: j.errors,
      };
    }
    return { jobs };
  }

  /**
   * Start a collection + analysis run.
   * @param {object} opts
   * @param {string} opts.jobId
   * @param {object} opts.request { method, url, headers, body, timeoutMs }
   * @param {number} [opts.count=200]
   * @param {object} opts.tokenSource { type, ... }
   * @param {number} [opts.concurrency=10]
   * @returns {Promise<{jobId, analysis}>}
   */
  async start({ jobId, request, count, tokenSource, concurrency } = {}) {
    if (!jobId) {
      const msg = 'Sequencer.start: jobId is required';
      this.emit('error', msg);
      return { error: msg };
    }
    if (!request || !request.url) {
      const msg = 'Sequencer.start: request.url is required';
      this.emit('error', msg);
      return { jobId, error: msg };
    }
    const existing = this.jobs.get(jobId);
    if (existing && existing.running) {
      return { jobId, error: 'Job already running' };
    }

    const total = clampInt(count, 1, MAX_TOKENS, 200);
    const conc = clampInt(concurrency, 1, 200, 10);
    const source = tokenSource || { type: 'regex', pattern: '.*', group: 0 };

    const job = {
      tokens: [],
      total,
      collected: 0,
      running: true,
      stopped: false,
      errors: 0,
      request,
      tokenSource: source,
    };
    this.jobs.set(jobId, job);
    this.emit('status', this.state());

    // Dispatch `total` requests with a bounded pool of `conc` workers.
    let dispatched = 0;
    const worker = async () => {
      while (job.running && dispatched < total) {
        dispatched += 1;
        let res;
        try {
          res = await sendRequest({
            method: request.method || 'GET',
            url: request.url,
            headers: request.headers || {},
            body: request.body,
            timeoutMs: request.timeoutMs || 30000,
          });
        } catch (e) {
          res = { error: e && e.message ? e.message : String(e) };
        }
        if (!job.running) break;
        if (res && res.error) {
          job.errors += 1;
        } else {
          const token = extractToken(res, source);
          if (token != null && token !== '') {
            if (job.tokens.length < MAX_TOKENS) job.tokens.push(token);
          } else {
            job.errors += 1;
          }
        }
        job.collected += 1;
        this.emit('seq-progress', {
          jobId,
          collected: job.collected,
          total,
        });
      }
    };

    const pool = [];
    for (let i = 0; i < Math.min(conc, total); i++) pool.push(worker());
    await Promise.all(pool);

    job.running = false;
    const analysis = analyze(job.tokens);
    analysis.jobId = jobId;
    analysis.errors = job.errors;
    analysis.requested = total;
    analysis.stopped = job.stopped;
    this.emit('status', this.state());
    this.emit('seq-done', { jobId, analysis });
    return { jobId, analysis };
  }

  /** Return the raw tokens collected for a job (or empty array). */
  getTokens(jobId) {
    const j = this.jobs.get(jobId);
    return j ? j.tokens.slice() : [];
  }

  /** Request a running job to stop. Already-dispatched requests may still land. */
  stop(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return { jobId, error: 'No such job' };
    j.running = false;
    j.stopped = true;
    this.emit('status', this.state());
    return { jobId, collected: j.collected, total: j.total, stopped: true };
  }
}

// --------------------------- helpers ----------------------------

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/**
 * Pull a token out of a repeater response per the token source spec.
 * tokenSource:
 *   { type:'header', name }
 *   { type:'cookie', name }
 *   { type:'regex', pattern, group }
 *   { type:'json', path }  (dot path, supports [idx])
 */
function extractToken(res, source) {
  if (!res || !source) return null;
  try {
    switch (source.type) {
      case 'header':
        return getHeader(res.headers, source.name);
      case 'cookie':
        return getCookie(res.headers, source.name);
      case 'regex': {
        if (!source.pattern) return null;
        const re = new RegExp(source.pattern);
        const m = re.exec(res.body || '');
        if (!m) return null;
        const g = source.group == null ? 0 : Number(source.group);
        return m[g] != null ? String(m[g]) : null;
      }
      case 'json':
        return getJsonPath(res.body, source.path);
      default:
        return null;
    }
  } catch (_) {
    return null;
  }
}

function getHeader(headers, name) {
  if (!headers || !name) return null;
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) {
      const v = headers[k];
      return Array.isArray(v) ? String(v[0]) : String(v);
    }
  }
  return null;
}

function getCookie(headers, name) {
  if (!headers || !name) return null;
  // Node lowercases response header keys; set-cookie is an array.
  let setCookie = headers['set-cookie'];
  if (!setCookie) {
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === 'set-cookie') {
        setCookie = headers[k];
        break;
      }
    }
  }
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const want = String(name);
  for (const line of arr) {
    // Each cookie line: "name=value; Path=/; HttpOnly"
    const first = String(line).split(';')[0];
    const eq = first.indexOf('=');
    if (eq === -1) continue;
    const key = first.slice(0, eq).trim();
    if (key === want) return first.slice(eq + 1).trim();
  }
  return null;
}

function getJsonPath(body, path) {
  if (!body || !path) return null;
  let obj;
  try {
    obj = JSON.parse(body);
  } catch (_) {
    return null;
  }
  // Split on dots and [index] segments.
  const parts = String(path)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((p) => p !== '');
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  if (cur == null) return null;
  return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
}

/**
 * Statistical analysis of a token sample.
 * Returns an object safe to serialize over IPC.
 */
function analyze(tokens) {
  const n = tokens.length;
  if (n === 0) {
    return {
      tokens: 0,
      duplicates: 0,
      unique: 0,
      lengths: { min: 0, max: 0, mean: 0 },
      overallEntropy: 0,
      estimatedBits: 0,
      perPosition: [],
      verdict: 'insufficient data',
    };
  }

  // Length stats
  let minLen = Infinity;
  let maxLen = 0;
  let sumLen = 0;
  for (const t of tokens) {
    const L = t.length;
    if (L < minLen) minLen = L;
    if (L > maxLen) maxLen = L;
    sumLen += L;
  }
  const meanLen = sumLen / n;

  // Duplicates
  const seen = new Set();
  let duplicates = 0;
  for (const t of tokens) {
    if (seen.has(t)) duplicates += 1;
    else seen.add(t);
  }
  const unique = seen.size;

  // Per-position character frequency + Shannon entropy.
  // Analyze up to the minimum observed length so every token contributes to
  // each analyzed position (positions beyond that would have a varying sample).
  const analyzeLen = minLen === Infinity ? 0 : minLen;
  const perPosition = [];
  let sumPositionEntropy = 0;
  for (let pos = 0; pos < analyzeLen; pos++) {
    const freq = Object.create(null);
    for (const t of tokens) {
      const ch = t[pos];
      freq[ch] = (freq[ch] || 0) + 1;
    }
    const entropy = shannon(freq, n);
    sumPositionEntropy += entropy;
    perPosition.push({
      position: pos,
      distinct: Object.keys(freq).length,
      entropy: round(entropy, 4),
      frequency: freq,
    });
  }

  // Overall per-character entropy = mean of per-position entropies (bits/char).
  const overallEntropy = analyzeLen > 0 ? sumPositionEntropy / analyzeLen : 0;

  // Estimated total bits of entropy across the (minimum-length) token.
  const estimatedBits = sumPositionEntropy;

  // Verdict: judge bits of entropy PER CHARACTER against rough thresholds.
  // A truly random alphanumeric char is ~5.95 bits; hex ~4 bits. We grade on a
  // normalized scale so short alphabets are not unfairly punished.
  let verdict;
  if (n < 20) {
    verdict = 'insufficient data';
  } else if (overallEntropy >= 3.5) {
    verdict = 'good';
  } else if (overallEntropy >= 2.0) {
    verdict = 'moderate';
  } else {
    verdict = 'poor';
  }
  // A high duplicate rate is an automatic downgrade regardless of entropy.
  if (n >= 20 && duplicates / n > 0.01 && verdict === 'good') {
    verdict = 'moderate';
  }
  if (n >= 20 && duplicates / n > 0.1) {
    verdict = 'poor';
  }

  return {
    tokens: n,
    duplicates,
    unique,
    lengths: { min: minLen === Infinity ? 0 : minLen, max: maxLen, mean: round(meanLen, 2) },
    analyzedLength: analyzeLen,
    overallEntropy: round(overallEntropy, 4),
    estimatedBits: round(estimatedBits, 2),
    perPosition,
    verdict,
  };
}

/** Shannon entropy (bits) of a frequency map over `total` samples. */
function shannon(freq, total) {
  let h = 0;
  for (const k of Object.keys(freq)) {
    const p = freq[k] / total;
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

function round(v, places) {
  const f = Math.pow(10, places);
  return Math.round(v * f) / f;
}

module.exports = { Sequencer };
