'use strict';

const https = require('https');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Passive subdomain enumeration — the OSINT half of a tool like Sublist3r,
 * without any Python dependency. Queries public Certificate Transparency logs
 * (crt.sh) for certificates issued to *.<domain> and extracts the hostnames.
 *
 * This is passive reconnaissance against public CT data; actually probing or
 * auditing the discovered hosts is a separate, active step the operator must be
 * authorized to perform.
 *
 *   enumerateSubdomains(domain) -> Promise<{ domain, count, subdomains: string[] }>
 */
function getText(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'ProxyAudit-Recon/1.0', Accept: 'application/json, text/plain, */*' } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; if (data.length > 25 * 1024 * 1024) req.destroy(); });
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
  });
}

/** GET with a few retries — crt.sh in particular 502s/times out intermittently. */
async function getTextRetry(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await getText(url); }
    catch (e) { lastErr = e; await sleep(600 * (i + 1)); }
  }
  throw lastErr || new Error('request failed');
}

function cleanDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  d = d.replace(/^\*\./, '').replace(/\.$/, '');
  return d;
}

function addHost(set, base, raw) {
  let n = String(raw || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!n || /[^a-z0-9.-]/.test(n)) return;
  if (n === base || n.endsWith('.' + base)) set.add(n);
}

/** Source 1: crt.sh Certificate Transparency JSON (same source Sublist3r uses). */
async function fromCrtSh(base, set) {
  const url = 'https://crt.sh/?q=' + encodeURIComponent('%.' + base) + '&output=json';
  const body = await getTextRetry(url, 3);
  let rows;
  try { rows = JSON.parse(body); } catch (_) { rows = []; }
  if (!Array.isArray(rows)) return;
  for (const r of rows) {
    for (const n of String((r && r.name_value) || '').split(/\n+/)) addHost(set, base, n);
    if (r && r.common_name) addHost(set, base, r.common_name);
  }
}

/** Source 2 (fallback): HackerTarget hostsearch — CSV "host,ip" lines. */
async function fromHackerTarget(base, set) {
  const url = 'https://api.hackertarget.com/hostsearch/?q=' + encodeURIComponent(base);
  const body = await getTextRetry(url, 2);
  if (/API count exceeded|error/i.test(body)) return;
  for (const line of body.split(/\r?\n/)) addHost(set, base, line.split(',')[0]);
}

async function enumerateSubdomains(domain) {
  const base = cleanDomain(domain);
  if (!base || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(base)) {
    throw new Error('Invalid domain: ' + domain);
  }
  const set = new Set();
  const errors = [];
  // Run both sources; succeed if either returns anything.
  const results = await Promise.allSettled([fromCrtSh(base, set), fromHackerTarget(base, set)]);
  for (const r of results) if (r.status === 'rejected') errors.push(String(r.reason && r.reason.message || r.reason));

  const subdomains = Array.from(set).sort();
  if (!subdomains.length && errors.length === results.length) {
    throw new Error('all sources failed (' + errors.join('; ') + ')');
  }
  return { domain: base, count: subdomains.length, subdomains, sources: ['crt.sh', 'hackertarget'] };
}

module.exports = { enumerateSubdomains, cleanDomain };
