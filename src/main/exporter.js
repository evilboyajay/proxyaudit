'use strict';

/**
 * Export / import of proxy history.
 *
 * Pure functions (toJSON / toHAR / fromJSON) have no dependency on electron or
 * the filesystem so they can be unit-tested directly. The save/open helpers
 * accept `dialog` and `fs` so tests can inject fakes, and the thin electron
 * wrappers at the bottom require electron lazily (inside the functions) so that
 * merely requiring this module never pulls in electron.
 */

const EXPORT_VERSION = 1;
const APP_NAME = 'burp-alt';

// ----------------------------- helpers -----------------------------

function asArray(flowsOrStore) {
  if (!flowsOrStore) return [];
  if (Array.isArray(flowsOrStore)) return flowsOrStore;
  // Accept a Store instance (has listFlows + flows) or anything with `.flows`.
  if (Array.isArray(flowsOrStore.flows)) return flowsOrStore.flows;
  if (typeof flowsOrStore.listFlows === 'function') return flowsOrStore.listFlows();
  return [];
}

function headersToPairs(headers) {
  const out = [];
  if (!headers || typeof headers !== 'object') return out;
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) out.push({ name: String(name), value: String(v) });
    } else {
      out.push({ name: String(name), value: String(value == null ? '' : value) });
    }
  }
  return out;
}

function queryStringPairs(url) {
  const out = [];
  if (!url || typeof url !== 'string') return out;
  const qIndex = url.indexOf('?');
  if (qIndex === -1) return out;
  let query = url.slice(qIndex + 1);
  const hashIndex = query.indexOf('#');
  if (hashIndex !== -1) query = query.slice(0, hashIndex);
  if (!query) return out;
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawName = eq === -1 ? part : part.slice(0, eq);
    const rawValue = eq === -1 ? '' : part.slice(eq + 1);
    let name = rawName;
    let value = rawValue;
    try {
      name = decodeURIComponent(rawName.replace(/\+/g, ' '));
    } catch (_) { /* keep raw */ }
    try {
      value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
    } catch (_) { /* keep raw */ }
    out.push({ name, value });
  }
  return out;
}

function headerValue(headers, wanted) {
  if (!headers || typeof headers !== 'object') return '';
  const lw = wanted.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (String(name).toLowerCase() === lw) {
      return Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value);
    }
  }
  return '';
}

function toISO(ts) {
  const n = Number(ts);
  const d = new Date(Number.isFinite(n) ? n : Date.now());
  const valid = !Number.isNaN(d.getTime());
  return (valid ? d : new Date()).toISOString();
}

// --------------------------- pure functions ---------------------------

/**
 * Pretty JSON string of the full flows, self-describing with a version field.
 */
function toJSON(flowsOrStore) {
  const flows = asArray(flowsOrStore);
  const doc = {
    format: APP_NAME + '-history',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    count: flows.length,
    flows,
  };
  return JSON.stringify(doc, null, 2);
}

/**
 * A valid HAR 1.2 object.
 */
function toHAR(flowsOrStore) {
  const flows = asArray(flowsOrStore);
  const entries = flows.map((flow) => {
    const req = flow.request || {};
    const res = flow.response || {};
    const reqHeaders = headersToPairs(req.headers);
    const resHeaders = headersToPairs(res.headers);
    const mimeType = res.mime || headerValue(res.headers, 'content-type') || '';

    const request = {
      method: flow.method || 'GET',
      url: flow.url || '',
      httpVersion: flow.httpVersion || 'HTTP/1.1',
      cookies: [],
      headers: reqHeaders,
      queryString: queryStringPairs(flow.url),
      headersSize: -1,
      bodySize: req.body != null ? Buffer.byteLength(String(req.body)) : 0,
    };
    if (req.body != null && String(req.body).length > 0) {
      request.postData = {
        mimeType: headerValue(req.headers, 'content-type') || 'application/octet-stream',
        text: String(req.body),
      };
    }

    const bodyText = res.body != null ? String(res.body) : '';
    const size = res.length != null ? Number(res.length) : Buffer.byteLength(bodyText);

    const response = {
      status: res.status != null ? Number(res.status) : 0,
      statusText: res.statusMessage || '',
      httpVersion: flow.httpVersion || 'HTTP/1.1',
      cookies: [],
      headers: resHeaders,
      content: {
        size: Number.isFinite(size) ? size : bodyText.length,
        mimeType: mimeType || 'application/octet-stream',
        text: bodyText,
      },
      redirectURL: headerValue(res.headers, 'location'),
      headersSize: -1,
      bodySize: Number.isFinite(size) ? size : bodyText.length,
    };

    const time = Number(flow.durationMs);
    return {
      startedDateTime: toISO(flow.ts),
      time: Number.isFinite(time) ? time : 0,
      request,
      response,
      cache: {},
      timings: {
        send: 0,
        wait: Number.isFinite(time) ? time : 0,
        receive: 0,
      },
    };
  });

  return {
    log: {
      version: '1.2',
      creator: { name: APP_NAME, version: String(EXPORT_VERSION) },
      entries,
    },
  };
}

/**
 * Parse an exported JSON string back into an array of flow objects.
 * Validates the shape loosely and ignores unknown fields.
 */
function fromJSON(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error('Not valid JSON: ' + e.message);
  }

  let rawFlows;
  if (Array.isArray(doc)) {
    rawFlows = doc;
  } else if (doc && Array.isArray(doc.flows)) {
    rawFlows = doc.flows;
  } else {
    throw new Error('Unrecognized file: expected an array of flows or a { flows: [] } document.');
  }

  const out = [];
  for (const f of rawFlows) {
    const flow = normalizeFlow(f);
    if (flow) out.push(flow);
  }
  return out;
}

function normalizeFlow(f) {
  if (!f || typeof f !== 'object') return null;
  const req = f.request && typeof f.request === 'object' ? f.request : {};
  const res = f.response && typeof f.response === 'object' ? f.response : null;

  const flow = {
    id: f.id != null ? String(f.id) : genId(),
    ts: Number.isFinite(Number(f.ts)) ? Number(f.ts) : Date.now(),
    scheme: f.scheme || 'https',
    method: f.method || 'GET',
    host: f.host || '',
    url: f.url || '',
    path: f.path || '',
    httpVersion: f.httpVersion || 'HTTP/1.1',
    request: {
      headers: req.headers && typeof req.headers === 'object' ? req.headers : {},
      body: req.body != null ? String(req.body) : '',
    },
    response: null,
    durationMs: Number.isFinite(Number(f.durationMs)) ? Number(f.durationMs) : 0,
  };

  if (res) {
    flow.response = {
      status: res.status != null ? Number(res.status) : null,
      statusMessage: res.statusMessage || '',
      headers: res.headers && typeof res.headers === 'object' ? res.headers : {},
      body: res.body != null ? String(res.body) : '',
      mime: res.mime || '',
      length: res.length != null ? Number(res.length) : 0,
    };
  }

  return flow;
}

let _idSeq = 0;
function genId() {
  _idSeq += 1;
  return 'imported-' + Date.now().toString(36) + '-' + _idSeq;
}

// ------------------- injectable save/open helpers -------------------

/**
 * Save `data` (string or Buffer) to a file the user picks.
 * `dialog` and `fs` are injected so this can be tested without electron.
 * Returns { canceled, filePath }.
 */
async function saveData({ dialog, fs, window, defaultName, data, filters }) {
  const result = await dialog.showSaveDialog(window || null, {
    defaultPath: defaultName,
    filters: filters || [],
  });
  if (result.canceled || !result.filePath) {
    return { canceled: true, filePath: null };
  }
  await fs.promises.writeFile(result.filePath, data);
  return { canceled: false, filePath: result.filePath };
}

/**
 * Prompt the user to open a file and return its text contents.
 * Returns { canceled, filePath, text }.
 */
async function openData({ dialog, fs, window, filters }) {
  const result = await dialog.showOpenDialog(window || null, {
    properties: ['openFile'],
    filters: filters || [],
  });
  if (result.canceled || !result.filePaths || !result.filePaths.length) {
    return { canceled: true, filePath: null, text: null };
  }
  const filePath = result.filePaths[0];
  const text = await fs.promises.readFile(filePath, 'utf8');
  return { canceled: false, filePath, text };
}

// ------------------- thin electron wrappers -------------------
// electron + fs are required INSIDE the functions so requiring this module in a
// plain Node test never loads electron.

async function saveDialog({ window, defaultName, data, filters }) {
  const { dialog } = require('electron');
  const fs = require('fs');
  return saveData({ dialog, fs, window, defaultName, data, filters });
}

async function openDialog({ window, filters }) {
  const { dialog } = require('electron');
  const fs = require('fs');
  return openData({ dialog, fs, window, filters });
}

module.exports = {
  EXPORT_VERSION,
  // pure
  toJSON,
  toHAR,
  fromJSON,
  // injectable (testable) helpers
  saveData,
  openData,
  // electron-backed convenience wrappers
  saveDialog,
  openDialog,
};
