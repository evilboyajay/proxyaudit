'use strict';

// Wrapped in an IIFE so top-level declarations (notably `api`) are
// function-scoped. A bare global `const api` collides with the
// non-configurable `window.api` that contextBridge exposes, which is a
// SyntaxError that aborts the whole script in a real <script> context.
(function () {
const api = window.api;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// ----------------------------- state -----------------------------
const flows = new Map(); // id -> summary
let selectedFlowId = null;
let currentFlow = null; // last fully-loaded flow (Proxy or Target), for shortcuts

// Static fallback lineup, used if the live model list can't be fetched.
// '' = Default: let the SDK use your Claude Code account default.
const FALLBACK_MODELS = [
  { id: '', label: 'Default (account)' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'opus', label: 'opus (alias)' },
  { id: 'sonnet', label: 'sonnet (alias)' },
  { id: 'haiku', label: 'haiku (alias)' },
];
// Replaced at init by the live list from the Anthropic Models API if available.
let modelList = FALLBACK_MODELS;
function populateModelSelect(sel, selected) {
  if (!sel) return;
  sel.innerHTML = modelList.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join('');
  // Keep the saved value even if it isn't in the live list (append it), else Default.
  if (selected && !modelList.some((m) => m.id === selected)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(selected)}">${esc(selected)}</option>`);
  }
  sel.value = modelList.some((m) => m.id === selected) || selected ? selected : '';
}
let detailPane = 'req';
const interceptQueue = []; // full flow objects held for the user

// =============================== nav ===============================
// Burp-style two-level nav: top groups + per-group sub-tabs.
const GROUP_DEFAULT = {
  target: 'sitemap', proxy: 'proxy', repeater: 'repeater', intruder: 'intruder',
  sequencer: 'sequencer', decoder: 'decoder', comparer: 'comparer',
  discovery: 'discovery', collaborator: 'collaborator', build: 'build', settings: 'settings',
};
function groupOfView(view) {
  const sub = document.querySelector(`#subtabbar .subnav[data-view="${view}"]`);
  if (sub) return sub.closest('.subnav-group').dataset.group;
  return view; // single-view groups: group id === view id
}
$$('#tabbar .nav').forEach((btn) =>
  btn.addEventListener('click', () =>
    showView(GROUP_DEFAULT[btn.dataset.group] || btn.dataset.group)
  )
);
$$('#subtabbar .subnav').forEach((btn) =>
  btn.addEventListener('click', () => showView(btn.dataset.view))
);
function showView(view) {
  const group = groupOfView(view);
  $$('#tabbar .nav').forEach((b) => b.classList.toggle('active', b.dataset.group === group));
  let hasSub = false;
  $$('#subtabbar .subnav-group').forEach((g) => {
    const on = g.dataset.group === group;
    g.classList.toggle('hidden', !on);
    if (on) hasSub = true;
  });
  $('#subtabbar').classList.toggle('hidden', !hasSub);
  $$('#subtabbar .subnav').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  if (view === 'sitemap' && typeof renderSitemap === 'function') renderSitemap();
}

// =========================== utilities ============================
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function fmtLen(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function statusClass(s) {
  if (!s) return '';
  return `st-${String(s)[0]}`;
}

function headerLines(headers) {
  if (!headers) return '';
  return Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
}
function buildRequestRaw(flow) {
  const r = flow.request || {};
  let s = `${flow.method} ${flow.path} HTTP/${flow.httpVersion || '1.1'}\n`;
  s += headerLines(r.headers);
  s += '\n\n';
  if (r.body) s += r.body;
  if (r.bodyTruncated) s += '\n\n...[request body truncated]...';
  return s;
}
function buildResponseRaw(flow) {
  const r = flow.response;
  if (!r) return '(no response captured yet)';
  let s = `HTTP/${flow.httpVersion || '1.1'} ${r.status} ${r.statusMessage || ''}\n`;
  s += headerLines(r.headers);
  s += '\n\n';
  if (r.body) s += r.body;
  if (r.bodyTruncated) s += '\n\n...[response body truncated]...';
  return s;
}
function parseHeadersBody(text) {
  const idx = text.indexOf('\n\n');
  const headPart = idx >= 0 ? text.slice(0, idx) : text;
  const body = idx >= 0 ? text.slice(idx + 2) : '';
  const headers = {};
  headPart.split('\n').forEach((line) => {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c).trim()] = line.slice(c + 1).trim();
  });
  return { headers, body };
}
function parseRawRequest(text) {
  const idx = text.indexOf('\n\n');
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const body = idx >= 0 ? text.slice(idx + 2) : '';
  const lines = head.split('\n');
  const reqLine = lines.shift() || '';
  const parts = reqLine.split(/\s+/);
  const method = parts[0] || 'GET';
  const path = parts[1] || '/';
  const headers = {};
  lines.forEach((line) => {
    const c = line.indexOf(':');
    if (c > 0) headers[line.slice(0, c).trim()] = line.slice(c + 1).trim();
  });
  return { method, path, headers, body };
}

// ========================== proxy control =========================
const toggleProxyBtn = $('#toggleProxyBtn');
let proxyRunning = false;

toggleProxyBtn.addEventListener('click', async () => {
  toggleProxyBtn.disabled = true;
  try {
    if (proxyRunning) await api.stopProxy();
    else await api.startProxy();
  } catch (e) {
    toast('Proxy error: ' + e.message);
  }
  toggleProxyBtn.disabled = false;
});

$('#interceptToggle').addEventListener('change', (e) => {
  api.setIntercept(e.target.checked);
});
// Burp-style in-tab toggle button.
$('#interceptToggleBtn').addEventListener('click', () => {
  const on = !$('#interceptToggle').checked;
  $('#interceptToggle').checked = on;
  api.setIntercept(on);
});

async function openTestBrowser() {
  const btn = $('#openBrowserBtn');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Opening…';
  const res = await api.openBrowser({ binaryPath: $('#setBrowser')?.value || '' });
  btn.disabled = false;
  btn.textContent = prev;
  if (res.ok) toast(res.warning ? '⚠ ' + res.warning : 'Opened ' + res.browser + ' through the proxy', res.warning ? 5000 : 2600);
  else toast('⚠ ' + (res.error || 'Could not open browser'), 6000);
}
$('#openBrowserBtn').addEventListener('click', openTestBrowser);
document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'openBrowserBtn2') openTestBrowser();
});

function applyStatus(state) {
  proxyRunning = !!state.running;
  const pill = $('#statusPill');
  pill.textContent = proxyRunning ? `Proxy running :${state.port}` : 'Proxy stopped';
  pill.className = 'pill ' + (proxyRunning ? 'on' : 'off');
  toggleProxyBtn.textContent = proxyRunning ? 'Stop proxy' : 'Start proxy';
  $('#portLabel').textContent = proxyRunning ? '127.0.0.1:' + state.port : '';
  if (typeof state.intercept === 'boolean') {
    $('#interceptToggle').checked = state.intercept;
    $('#interceptState').textContent = state.intercept
      ? 'Intercept is ON. New requests are held below.'
      : 'Intercept is off.';
    const ib = $('#interceptToggleBtn');
    if (ib) {
      ib.textContent = state.intercept ? 'Intercept is on' : 'Intercept is off';
      ib.classList.toggle('primary', state.intercept);
    }
  }
  if (state.caPath) {
    $('#caPathText').textContent = state.caPath;
    $('#proxyAddr').textContent = '127.0.0.1:' + state.port;
  }
}

// ============================ flow table ==========================
const flowBody = $('#flowBody');
// HTTP message viewers (Pretty / Raw / Hex) for the Proxy detail pane.
const reqViewer = MsgView.mount($('#reqView'));
const resViewer = MsgView.mount($('#resView'));
let flowFilter = '';
$('#flowFilter').addEventListener('input', (e) => {
  flowFilter = e.target.value.toLowerCase();
  renderFlowTable();
});
$('#clearFlowsBtn').addEventListener('click', async () => {
  await api.clearFlows();
  flows.clear();
  selectedFlowId = null;
  renderFlowTable();
  reqViewer.setMessage('Select a request to inspect.');
  resViewer.setMessage('');
  updateDetailActions(null);
});

let scopeOnly = false;
let httpFilterState = HttpFilter.defaultState();
const httpFilterDialog = HttpFilter.mountDialog({
  onApply(state) {
    httpFilterState = state;
    renderFlowTable();
    updateFilterBadge();
  },
});
function updateFilterBadge() {
  const dot = $('#flowFilterBadge');
  if (dot) dot.classList.toggle('hidden', !HttpFilter.isActive(httpFilterState));
}
$('#flowFilterBtn').addEventListener('click', () => httpFilterDialog.open(httpFilterState));

function flowMatches(f) {
  if (scopeOnly && f.inScope === false) return false;
  if (!HttpFilter.matches(f, httpFilterState)) return false;
  if (!flowFilter) return true;
  return (
    `${f.method} ${f.host} ${f.path} ${f.status || ''} ${f.mime}`
      .toLowerCase()
      .includes(flowFilter)
  );
}
function rowHtml(f) {
  const n = f.id.split('-').pop();
  return (
    `<tr data-id="${f.id}" class="${f.id === selectedFlowId ? 'selected' : ''}">` +
    `<td class="muted">${n}</td>` +
    `<td class="method m-${f.method}">${f.method}</td>` +
    `<td title="${esc(f.host)}">${esc(f.host)}</td>` +
    `<td title="${esc(f.path)}">${esc(f.path)}</td>` +
    `<td class="${statusClass(f.status)}">${f.status || ''}</td>` +
    `<td class="muted">${esc(f.mime || '')}</td>` +
    `<td class="muted">${fmtLen(f.length)}</td>` +
    `</tr>`
  );
}
let renderScheduled = false;
const flowSort = { key: null, dir: 1 }; // null = capture order
const FLOW_NUMERIC = { ts: 1, status: 1, length: 1 };
function renderFlowTable() {
  renderScheduled = false;
  const rows = [];
  for (const f of flows.values()) if (flowMatches(f)) rows.push(f);
  if (flowSort.key) {
    const k = flowSort.key;
    const num = FLOW_NUMERIC[k];
    rows.sort((a, b) => {
      let av = a[k], bv = b[k];
      if (num) { av = Number(av) || 0; bv = Number(bv) || 0; return (av - bv) * flowSort.dir; }
      av = (av == null ? '' : String(av)).toLowerCase();
      bv = (bv == null ? '' : String(bv)).toLowerCase();
      return av < bv ? -flowSort.dir : av > bv ? flowSort.dir : 0;
    });
  }
  flowBody.innerHTML = rows.map(rowHtml).join('');
  $('#flowCount').textContent = flows.size;
}
// Click a column header to sort (toggles asc/desc); click again to cycle off.
$$('#flowTable thead th').forEach((th) => {
  if (!th.dataset.key) return;
  th.style.cursor = 'pointer';
  th.addEventListener('click', () => {
    const key = th.dataset.key;
    if (flowSort.key !== key) { flowSort.key = key; flowSort.dir = 1; }
    else if (flowSort.dir === 1) { flowSort.dir = -1; }
    else { flowSort.key = null; } // third click: back to capture order
    updateSortHeaders();
    renderFlowTable();
  });
});
function updateSortHeaders() {
  $$('#flowTable thead th').forEach((th) => {
    if (!th.dataset.label) return;
    const active = flowSort.key === th.dataset.key;
    th.textContent = th.dataset.label + (active ? (flowSort.dir === 1 ? ' ▲' : ' ▼') : '');
    th.classList.toggle('sorted', active);
  });
}
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(renderFlowTable);
}

flowBody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (tr) selectFlow(tr.dataset.id);
});

// Arrow Up/Down move the selection through the active list (like Burp).
// Reuses each list's own row click handler, and finds the current row by its
// '.selected' class, so it works for Proxy history, Target contents, WebSockets,
// and Intruder results alike.
const ARROW_LISTS = {
  proxy: '#flowBody', sitemap: '#smContents', websockets: '#wsBody',
  intruder: '#intrBody', discovery: '#discBody', collaborator: '#collabBody',
};
window.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;
  const view = document.querySelector('.view.active');
  const sel = view && ARROW_LISTS[view.id.replace('view-', '')];
  if (!sel) return;
  const rows = Array.from(document.querySelectorAll(sel + ' tr'));
  if (!rows.length) return;
  let idx = rows.findIndex((r) => r.classList.contains('selected'));
  if (idx === -1) idx = e.key === 'ArrowDown' ? -1 : rows.length;
  const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
  e.preventDefault();
  rows[next].click();
  if (typeof rows[next].scrollIntoView === 'function') rows[next].scrollIntoView({ block: 'nearest' });
});

async function selectFlow(id) {
  selectedFlowId = id;
  $$('#flowBody tr').forEach((tr) =>
    tr.classList.toggle('selected', tr.dataset.id === id)
  );
  const flow = await api.getFlow(id);
  if (!flow) return;
  selectFlow._current = flow;
  currentFlow = flow;
  reqViewer.setMessage(buildRequestRaw(flow));
  resViewer.setMessage(buildResponseRaw(flow));
  updateDetailActions(flow);
}

function updateDetailActions(flow) {
  const hasFlow = !!flow;
  $('#toRepeaterBtn').disabled = !hasFlow;
  $('#toIntruderBtn').disabled = !hasFlow;
  $('#toComparerBtn').disabled = !(hasFlow && flow.response);
}

// detail request/response pane switch (scoped to the Proxy view)
$$('#view-proxy .seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    detailPane = b.dataset.pane;
    $$('#view-proxy .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('#reqView').classList.toggle('hidden', detailPane !== 'req');
    $('#resView').classList.toggle('hidden', detailPane !== 'res');
  })
);

// detail actions
$('#toRepeaterBtn').addEventListener('click', () => {
  const flow = selectFlow._current;
  if (flow) sendFlowToRepeater(flow);
});
$('#toComparerBtn').addEventListener('click', () => {
  const flow = selectFlow._current;
  if (flow && flow.response) window.sendToComparer(buildResponseRaw(flow), 'a');
});

// ========================= context menus =========================
function ctxCopy(text, okMsg) {
  navigator.clipboard.writeText(String(text == null ? '' : text))
    .then(() => toast(okMsg))
    .catch(() => toast('Copy failed'));
}
function extractLinks(flow) {
  const body = flow && flow.response && flow.response.body ? flow.response.body : '';
  const out = new Set();
  let m;
  const attr = /(?:href|src|action)\s*=\s*["']([^"']+)["']/gi;
  while ((m = attr.exec(body))) out.add(m[1]);
  const bare = /https?:\/\/[^\s"'<>)]+/gi;
  while ((m = bare.exec(body))) out.add(m[0]);
  return Array.from(out);
}
function aiPromptForFlow(flow) {
  const curl = window.ContextMenu && window.ContextMenu.buildCurl
    ? window.ContextMenu.buildCurl(flow)
    : `${flow.method} ${flow.url}`;
  const resHead = flow && flow.response
    ? `HTTP ${flow.response.status} ${flow.response.statusMessage || ''}\n` +
      Object.entries(flow.response.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n') +
      '\n\n' + (flow.response.body || '').slice(0, 8000)
    : '(no response captured)';
  const p =
    'Analyze this captured request for security issues ' +
    '(auth/session, IDOR & access control, injection, SSRF, secrets/PII exposure, misconfig). ' +
    'Give concrete, evidence-based findings and, where warranted, how to verify/exploit it. ' +
    'You can re-run or tamper with the request below using send_request.\n\n' +
    'Request (curl):\n```bash\n' + curl + '\n```\n\n' +
    '=== RESPONSE ===\n' + resHead + '\n\n' +
    (flow && flow.id ? `(This is flow ${flow.id} in the proxy history — use get_flow/send_request to probe further.)` : '');
  return p.slice(0, 24000);
}
function sendFlowToAI(flow, newChat) {
  if (!flow) return;
  showView('build');
  const go = () => sendChat(aiPromptForFlow(flow));
  if (newChat) { chatStartNew(); setTimeout(go, 60); }
  else go();
  toast('Sent to AI' + (newChat ? ' (new chat)' : ''));
}

const ctxHistoryHandlers = {
  sendToAINew: (flow) => sendFlowToAI(flow, true),
  sendToAICurrent: (flow) => sendFlowToAI(flow, false),
  addToScope: (flow) => {
    api.scopeAdd({ mode: 'include', host: flow.host })
      .then((res) => toast(res && res.ok ? `Added ${flow.host} to scope` : '⚠ Could not add to scope'));
  },
  sendToRepeater: (flow) => sendFlowToRepeater(flow),
  sendToIntruder: (flow) => sendFlowToIntruder(flow),
  sendToComparer: (flow) => window.sendToComparer(buildRequestRaw(flow), 'a'),
  copyUrl: (flow) => ctxCopy(ContextMenu.urlOf(flow), 'URL copied'),
  copyCurl: (flow) => ctxCopy(ContextMenu.buildCurl(flow), 'curl command copied'),
  copyLinks: (flow) => {
    const links = extractLinks(flow);
    if (!links.length) { toast('No links found in response'); return; }
    ctxCopy(links.join('\n'), `${links.length} link(s) copied`);
  },
  deleteItem: (flow) => {
    flows.delete(flow.id);
    if (selectedFlowId === flow.id) {
      selectedFlowId = null;
      reqViewer.setMessage('Select a request to inspect.');
      resViewer.setMessage('');
      updateDetailActions(null);
    }
    renderFlowTable();
    toast('Item deleted');
  },
  clearHistory: () => { $('#clearFlowsBtn').click(); },
  saveItem: () => { api.exportJson().then(() => toast('Exported')); },
};
const ctxEditorHandlers = Object.assign({}, ctxHistoryHandlers, {
  changeMethod: (flow) => {
    const m = String(flow.method || 'GET').toUpperCase();
    if (m !== 'GET' && m !== 'POST') { toast('Change method applies to GET/POST'); return; }
    const next = m === 'GET' ? 'POST' : 'GET';
    sendFlowToRepeater(Object.assign({}, flow, { method: next }));
    toast(`Method changed to ${next} (sent to Repeater)`);
  },
  copyToClipboard: (flow) => {
    const sel = String(window.getSelection ? window.getSelection() : '');
    if (sel && sel.trim()) { ctxCopy(sel, 'Selection copied'); return; }
    const whole = detailPane === 'res' ? buildResponseRaw(flow) : buildRequestRaw(flow);
    ctxCopy(whole, 'Copied to clipboard');
  },
});
flowBody.addEventListener('contextmenu', async (e) => {
  const tr = e.target.closest('tr');
  if (!tr || !tr.dataset.id) return;
  e.preventDefault();
  const flow = await api.getFlow(tr.dataset.id);
  if (!flow) return;
  ContextMenu.show(e.clientX, e.clientY, ContextMenu.historyMenuItems(flow, ctxHistoryHandlers));
});
$('#flowDetail').addEventListener('contextmenu', (e) => {
  const flow = selectFlow._current || currentFlow;
  if (!flow) return;
  e.preventDefault();
  ContextMenu.show(e.clientX, e.clientY, ContextMenu.editorMenuItems(flow, ctxEditorHandlers));
});
// Target (site map) contents rows get the same menu (incl. Send to AI).
document.addEventListener('contextmenu', async (e) => {
  const tr = e.target.closest && e.target.closest('#smContents tr');
  if (!tr || !tr.dataset.id) return;
  e.preventDefault();
  const flow = await api.getFlow(tr.dataset.id);
  if (!flow) return;
  ContextMenu.show(e.clientX, e.clientY, ContextMenu.historyMenuItems(flow, ctxHistoryHandlers));
});

// ============================ intercept ===========================
const interceptEditor = $('#interceptEditor');
function refreshInterceptView() {
  const n = interceptQueue.length;
  const badge = $('#interceptCount');
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
  const current = interceptQueue[0];
  $('#forwardBtn').disabled = !current;
  $('#dropBtn').disabled = !current;
  if (current) {
    interceptEditor.value = buildRequestRaw(current);
    $('#interceptState').textContent = `Holding ${current.method} ${current.host} — ${n} in queue`;
  } else {
    interceptEditor.value = '';
    $('#interceptState').textContent = $('#interceptToggle').checked
      ? 'Intercept is ON. Waiting for requests…'
      : 'Intercept is off.';
  }
}
$('#forwardBtn').addEventListener('click', () => {
  const current = interceptQueue.shift();
  if (!current) return;
  const edited = parseRawRequest(interceptEditor.value);
  api.resolveIntercept(current.id, 'forward', edited);
  refreshInterceptView();
});
$('#dropBtn').addEventListener('click', () => {
  const current = interceptQueue.shift();
  if (!current) return;
  api.resolveIntercept(current.id, 'drop');
  refreshInterceptView();
});

// ============================ repeater ============================
let repeaterTabs = [];
let activeRepeaterTab = 0;
let repeaterSeq = 0;

function newRepeaterTab(preset) {
  repeaterSeq += 1;
  const tab = {
    id: repeaterSeq,
    name: preset?.name || `Req ${repeaterSeq}`,
    method: preset?.method || 'GET',
    url: preset?.url || '',
    request: preset?.request || '',
    response: 'No response yet.',
    meta: '',
  };
  repeaterTabs.push(tab);
  activeRepeaterTab = repeaterTabs.length - 1;
  renderRepeaterTabs();
  loadRepeaterTab();
}
function renderRepeaterTabs() {
  $('#repeaterTabs').innerHTML = repeaterTabs
    .map(
      (t, i) =>
        `<div class="tab ${i === activeRepeaterTab ? 'active' : ''}" data-i="${i}">${esc(t.name)}</div>`
    )
    .join('');
}
$('#repeaterTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  saveRepeaterTab();
  activeRepeaterTab = Number(tab.dataset.i);
  renderRepeaterTabs();
  loadRepeaterTab();
});
$('#newRepeaterTab').addEventListener('click', () => {
  saveRepeaterTab();
  newRepeaterTab();
});
function loadRepeaterTab() {
  const t = repeaterTabs[activeRepeaterTab];
  if (!t) return;
  $('#repMethod').value = t.method;
  $('#repUrl').value = t.url;
  $('#repRequest').value = t.request;
  $('#repResponse').textContent = t.response;
  $('#repMeta').textContent = t.meta;
}
function saveRepeaterTab() {
  const t = repeaterTabs[activeRepeaterTab];
  if (!t) return;
  t.method = $('#repMethod').value;
  t.url = $('#repUrl').value;
  t.request = $('#repRequest').value;
}
function sendFlowToRepeater(flow) {
  saveRepeaterTab();
  const { body } = { body: flow.request ? flow.request.body : '' };
  const headers = headerLines(flow.request ? flow.request.headers : {});
  newRepeaterTab({
    name: flow.method + ' ' + flow.host,
    method: flow.method,
    url: flow.url,
    request: headers + '\n\n' + (body || ''),
  });
  showView('repeater');
  toast('Sent to Repeater');
}
$('#repSendBtn').addEventListener('click', async () => {
  saveRepeaterTab();
  const t = repeaterTabs[activeRepeaterTab];
  if (!t || !t.url) {
    toast('Enter a URL');
    return;
  }
  const { headers, body } = parseHeadersBody(t.request);
  $('#repResponse').textContent = 'Sending…';
  $('#repMeta').textContent = '';
  const res = await api.sendRequest({
    method: t.method,
    url: t.url,
    headers,
    body: body && body.length ? body : null,
  });
  if (res.error) {
    t.response = 'Error: ' + res.error;
    t.meta = `${res.durationMs || 0} ms`;
  } else {
    t.response =
      `HTTP ${res.status} ${res.statusMessage || ''}\n` +
      headerLines(res.headers) +
      '\n\n' +
      (res.body || '');
    t.meta = `${res.status} · ${fmtLen(res.length)} · ${res.durationMs} ms`;
  }
  $('#repResponse').textContent = t.response;
  $('#repMeta').textContent = t.meta;
});

// =========================== websockets ===========================
const wsConns = new Map();
let selectedWs = null;
function renderWsList() {
  $('#wsCount').textContent = wsConns.size;
  $('#wsBody').innerHTML = Array.from(wsConns.values())
    .map(
      (w) =>
        `<tr data-id="${w.id}" class="${w.id === selectedWs ? 'selected' : ''}">` +
        `<td title="${esc(w.url)}">${w.closed ? '○' : '●'} ${esc(w.url)}</td></tr>`
    )
    .join('');
}
$('#wsBody').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  selectedWs = tr.dataset.id;
  renderWsList();
  const conn = await api.getWs(selectedWs);
  renderWsFrames(conn);
});
function renderWsFrames(conn) {
  if (!conn) return;
  $('#wsTitle').textContent = conn.url;
  $('#wsFrames').innerHTML = conn.messages
    .map((m) => {
      const out = m.direction === 'outgoing';
      const time = new Date(m.ts).toLocaleTimeString();
      const data = m.binary ? `[binary ${fmtLen(m.length)}]` : m.data;
      return (
        `<div class="ws-frame ${out ? 'out' : 'in'}">` +
        `<span class="arrow">${out ? '▲' : '▼'}</span>` +
        `<span class="wtime">${time}</span>` +
        `<span class="wdata">${esc(data)}</span></div>`
      );
    })
    .join('');
}

// =============================== build ============================
// Claude agent for security research — chat with proxy + filesystem tools.
//
// Each CONVERSATION is an independent agent that runs in the background. A
// conversation's in-flight turn is tracked in `runs` (keyed by conversation
// id); assistant events are routed to the right conversation by turn id and
// persisted to the store whether or not that conversation is on screen. Only
// the conversation currently shown (`chatActiveId`) renders live into the DOM —
// switching away never stops a run, and switching back re-renders from the
// store plus the run's live buffers. This is what lets many audits run at once.
let chatSessionId = null;          // active conversation's SDK session id
let chatTurnSeq = 0;
let chatActiveId = null;           // conversation currently shown (null = fresh/unsaved)
const runs = new Map();            // convId -> run state (see makeRun)
const turnToConv = new Map();      // turnId -> convId (route incoming events)
let nextGoal = null;               // goal to attach to the next run sendChat creates
// Live DOM refs — valid ONLY for chatActiveId's run; rebuilt when switching.
let actStreamEl = null, actThinkEl = null, actStatusEl = null, actTimer = null;

const CHAT_HELLO =
  '<div class="chat-hello muted">New chat. Ask me to audit the proxy traffic, find vulns, ' +
  'build a PoC, or crawl a target with the proxied browser.</div>';

const AUDIT_ALL_PROMPT =
  'Autonomously audit ALL captured HTTP traffic for security vulnerabilities. ' +
  'Start by calling list_flows to inventory every flow, then systematically get_flow the ' +
  'interesting endpoints (auth, APIs, anything with ids/params/tokens, admin/debug paths), ' +
  'search_flows for telltale strings, and list_js_files to review client-side code. ' +
  'Look for broken auth/session, IDOR & broken object-level authorization, injection ' +
  '(SQLi/command/SSTI/XSS/SSRF/path traversal/XXE), access-control and business-logic flaws, ' +
  'CSRF, open redirects, and secret/PII exposure. Use send_request to verify suspected issues, ' +
  'and open_in_browser to generate more coverage if traffic is thin. Then give me a ' +
  'prioritized, evidence-based report (flow ids + exact snippets) with reproduction steps, ' +
  'severity, and remediation. This is authorized testing.';

// Render a useful subset of Markdown to safe HTML. Everything is HTML-escaped
// first; fenced/inline code is pulled out into placeholders so its contents are
// never treated as markup, then restored last. Block elements (headings, lists,
// blockquotes, rules) are built line-by-line so we never inject <br> inside them.
function chatInline(s) {
  // s is already HTML-escaped. Order matters: code already extracted upstream.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  return s;
}
function chatMdLite(md) {
  const codeBlocks = [];
  const inlineCode = [];
  // 1) Pull fenced code blocks out first (escape their contents).
  let src = String(md == null ? '' : md).replace(/```[ \t]*([\w+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    codeBlocks.push(`<pre class="chat-code"><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return '\u0000CB' + (codeBlocks.length - 1) + '\u0000';
  });
  // 2) Pull inline code out (escape contents).
  src = src.replace(/`([^`\n]+?)`/g, (m, c) => {
    inlineCode.push(`<code>${esc(c)}</code>`);
    return '\u0000IC' + (inlineCode.length - 1) + '\u0000';
  });
  // 3) Escape everything else, then build blocks line by line.
  const lines = esc(src).split('\n');
  const out = [];
  let listType = null; // 'ul' | 'ol'
  let para = [];
  const closeList = () => { if (listType) { out.push('</' + listType + '>'); listType = null; } };
  const flushPara = () => {
    if (para.length) { out.push('<p>' + chatInline(para.join('<br>')) + '</p>'); para = []; }
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flushPara(); closeList(); continue; }
    let m;
    if (/^\u0000CB\d+\u0000$/.test(line.trim())) {
      flushPara(); closeList(); out.push(line.trim());
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      flushPara(); closeList();
      const level = Math.min(m[1].length, 6);
      out.push(`<h${level}>` + chatInline(m[2]) + `</h${level}>`);
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushPara(); closeList(); out.push('<hr>');
    } else if ((m = line.match(/^\s*&gt;\s?(.*)$/))) {
      // '>' is already HTML-escaped to '&gt;' at this point.
      flushPara(); closeList();
      out.push('<blockquote>' + chatInline(m[1]) + '</blockquote>');
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push('<li>' + chatInline(m[1]) + '</li>');
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushPara();
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push('<li>' + chatInline(m[1]) + '</li>');
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara(); closeList();
  let html = out.join('\n');
  // 4) Restore code placeholders.
  html = html.replace(/\u0000IC(\d+)\u0000/g, (m, i) => inlineCode[+i]);
  html = html.replace(/\u0000CB(\d+)\u0000/g, (m, i) => codeBlocks[+i]);
  return html;
}
function chatAppend(cls, html) {
  const hello = $('#chatMessages .chat-hello');
  if (hello) hello.remove();
  const el = document.createElement('div');
  el.className = 'chat-msg ' + cls;
  el.innerHTML = html;
  $('#chatMessages').appendChild(el);
  // Keep the live status line pinned to the bottom during a turn.
  if (actStatusEl && actStatusEl.parentNode && !cls.includes('status')) {
    $('#chatMessages').appendChild(actStatusEl);
  }
  $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
  return el;
}

// Claude-Code-style "working" words + a live elapsed/done status line.
const WORK_WORDS = [
  'Accomplishing', 'Baking', 'Booping', 'Brewing', 'Calculating', 'Cerebrating',
  'Channelling', 'Churning', 'Clauding', 'Coalescing', 'Cogitating', 'Computing',
  'Concocting', 'Conjuring', 'Considering', 'Contemplating', 'Cooking', 'Crafting',
  'Creating', 'Crunching', 'Deciphering', 'Deliberating', 'Determining', 'Divining',
  'Doing', 'Effecting', 'Elucidating', 'Enchanting', 'Envisioning', 'Finagling',
  'Forging', 'Forming', 'Formulating', 'Galloping', 'Generating', 'Germinating',
  'Hatching', 'Herding', 'Honking', 'Hustling', 'Ideating', 'Imagining',
  'Incubating', 'Inferring', 'Jamming', 'Manifesting', 'Marinating', 'Meandering',
  'Moseying', 'Mulling', 'Mustering', 'Musing', 'Noodling', 'Percolating',
  'Perusing', 'Philosophising', 'Pondering', 'Processing', 'Puttering', 'Puzzling',
  'Reticulating', 'Ruminating', 'Sautéing', 'Scheming', 'Schlepping', 'Shimmying',
  'Shucking', 'Simmering', 'Smooshing', 'Spinning', 'Stewing', 'Sussing',
  'Synthesizing', 'Thinking', 'Tinkering', 'Transmuting', 'Unfurling', 'Vibing',
  'Whirring', 'Wibbling', 'Working', 'Wrangling',
];
function randomWord() { return WORK_WORDS[Math.floor(Math.random() * WORK_WORDS.length)]; }
function makeRun(convId) {
  return {
    convId, turnId: null,
    streamBuf: '',          // current assistant text segment (persisted at boundaries)
    thinkBuf: '',           // current thinking text (ephemeral)
    turnText: '',           // full assistant text this turn (for GOAL COMPLETE detection)
    sessionId: chatSessionId,
    model: $('#chatModel').value,
    agentMode: $('#chatAgentMode').checked,
    goal: null, goalIter: 0,
    word: randomWord(), start: Date.now(), stopped: false,
  };
}
function isActive(convId) { return convId != null && convId === chatActiveId; }
function scrollMessages() { const b = $('#chatMessages'); b.scrollTop = b.scrollHeight; }

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
}
function statusHtml(run, done, stopped) {
  const elapsed = fmtElapsed(Date.now() - run.start);
  if (done) {
    const t = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return stopped
      ? `✦ ${esc(run.word)} · stopped after ${elapsed}`
      : `✦ ${esc(run.word)} for ${elapsed} · done ${t}`;
  }
  return `<span class="spinner"></span> ${esc(run.word)}…  ${elapsed}`;
}
// Attach the live status line + ticking timer to the active view for `run`.
function startActiveStatus(run) {
  if (actTimer) { clearInterval(actTimer); actTimer = null; }
  actStatusEl = chatAppend('status muted', statusHtml(run, false));
  actTimer = setInterval(() => {
    if (actStatusEl) actStatusEl.innerHTML = statusHtml(run, false);
    else { clearInterval(actTimer); actTimer = null; }
  }, 1000);
}
function finishActiveStatus(run, stopped) {
  if (actTimer) { clearInterval(actTimer); actTimer = null; }
  if (actStatusEl) {
    actStatusEl.innerHTML = statusHtml(run, true, stopped);
    actStatusEl.classList.add('done');
    actStatusEl = null;
  }
}
function closeStreamActive() {
  if (actStreamEl && actStreamEl.textContent.trim() === '') actStreamEl.remove();
  actStreamEl = null;
}
function closeThinkActive(run) {
  actThinkEl = null;
  if (run) run.thinkBuf = '';
}
// Persist the current assistant text segment to the run's conversation.
function flushSegment(run) {
  if (run.streamBuf && run.streamBuf.trim()) {
    api.chatAppend(run.convId, { role: 'assistant', content: run.streamBuf });
  }
  run.streamBuf = '';
  if (isActive(run.convId)) actStreamEl = null; // next text starts a fresh bubble
}
function chatSetBusy(busy) {
  // The Send button doubles as Stop while THIS conversation's turn runs.
  const sb = $('#chatSendBtn');
  sb.textContent = busy ? 'Stop' : 'Send';
  sb.classList.toggle('danger', busy);
  $('#chatStopBtn').disabled = !busy;
}
// Stop ONLY the conversation currently on screen; background runs keep going.
function stopChat() {
  const run = runs.get(chatActiveId);
  if (!run) return;
  api.assistantStop(run.turnId);
  run.stopped = true;
  run.goal = null;
  flushSegment(run);
  runs.delete(run.convId);
  turnToConv.delete(run.turnId);
  finishActiveStatus(run, true);
  chatSetBusy(false);
  updateGoalBar();
  chatLoadList();
}
function chatClearPending() {
  const p = $('#chatMessages .chat-msg.pending');
  if (p) p.remove();
}

// ---- chat history sidebar ----
async function chatLoadList() {
  let list = [];
  try { list = await api.chatsList(); } catch (_) { list = []; }
  const el = $('#chatList');
  el.innerHTML = '';
  if (!list.length) {
    el.innerHTML = '<div class="chat-list-empty muted">No conversations yet.</div>';
    return;
  }
  for (const c of list) {
    const running = runs.has(c.id);
    const item = document.createElement('div');
    item.className = 'chat-list-item' + (c.id === chatActiveId ? ' active' : '') + (running ? ' running' : '');
    if (running) {
      const dot = document.createElement('span');
      dot.className = 'chat-run-dot';
      dot.title = 'Working in the background';
      item.appendChild(dot);
    }
    const title = document.createElement('span');
    title.className = 'chat-list-title';
    title.textContent = c.title || 'New chat';
    const del = document.createElement('button');
    del.className = 'chat-list-del';
    del.textContent = '×';
    del.title = running ? 'Stop & delete conversation' : 'Delete conversation';
    item.appendChild(title);
    item.appendChild(del);
    item.addEventListener('click', () => { if (c.id !== chatActiveId) chatOpen(c.id); });
    title.addEventListener('dblclick', (e) => { e.stopPropagation(); chatBeginRename(item, c); });
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm('Delete this conversation?')) return;
      // Stop its background run first, if any.
      const r = runs.get(c.id);
      if (r) { try { api.assistantStop(r.turnId); } catch (_) {} runs.delete(c.id); turnToConv.delete(r.turnId); }
      await api.chatDelete(c.id);
      if (chatActiveId === c.id) chatStartNew();
      else chatLoadList();
    });
    el.appendChild(item);
  }
}
function chatBeginRename(item, c) {
  const titleEl = item.querySelector('.chat-list-title');
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'chat-rename-input input';
  input.value = c.title || '';
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let doneEditing = false;
  const commit = async () => {
    if (doneEditing) return;
    doneEditing = true;
    const v = input.value.trim();
    if (v) await api.chatRename(c.id, v);
    chatLoadList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { doneEditing = true; chatLoadList(); }
  });
  input.addEventListener('blur', commit);
}
function chatRenderStored(messages) {
  const box = $('#chatMessages');
  box.innerHTML = '';
  if (!messages || !messages.length) { box.innerHTML = CHAT_HELLO; return; }
  for (const m of messages) {
    if (m.role === 'user') {
      chatAppend('user', esc(m.content).replace(/\n/g, '<br>'));
    } else if (m.role === 'assistant') {
      chatAppend('assistant' + (m.meta && m.meta.error ? ' error' : ''), chatMdLite(m.content));
    } else if (m.role === 'tool') {
      const name = (m.meta && m.meta.name) || 'tool';
      chatAppend('tool', `<span class="chat-tool-name">⚙ ${esc(name)}</span> <code>${esc(m.content).slice(0, 400)}</code>`);
    } else if (m.role === 'tool_result') {
      chatAppend('tool-result', `<pre class="chat-code">${esc(m.content)}</pre>`);
    }
  }
}
// Tear down the active view's live DOM refs (the message box is about to be
// rebuilt). Does NOT touch any run — background turns keep streaming.
function detachActiveView() {
  if (actTimer) { clearInterval(actTimer); actTimer = null; }
  actStatusEl = null; actStreamEl = null; actThinkEl = null;
}
// Re-create live elements for a conversation that is still running, from its
// run buffers, so switching back shows in-progress output and the status line.
function reattachRun(run) {
  if (run.streamBuf && run.streamBuf.trim()) {
    actStreamEl = chatAppend('assistant', '');
    actStreamEl.innerHTML = chatMdLite(run.streamBuf);
  }
  if (run.thinkBuf) {
    actThinkEl = chatAppend('thinking muted', '');
    actThinkEl.textContent = '💭 ' + run.thinkBuf.slice(-4000);
  }
  startActiveStatus(run);
  scrollMessages();
}
async function chatOpen(id) {
  // Switching conversations NEVER stops a run — it keeps going in the
  // background. We just rebind the view to the selected conversation.
  let rec = null;
  try { rec = await api.chatGet(id); } catch (_) {}
  if (!rec) return;
  detachActiveView();
  chatActiveId = id;
  chatSessionId = rec.sessionId || null;
  chatRenderStored(rec.messages || []);
  const run = runs.get(id);
  if (run) { chatSessionId = run.sessionId || chatSessionId; reattachRun(run); chatSetBusy(true); }
  else chatSetBusy(false);
  updateGoalBar();
  chatLoadList();
}
function chatStartNew() {
  detachActiveView();
  chatActiveId = null;
  chatSessionId = null;
  $('#chatMessages').innerHTML = CHAT_HELLO;
  chatSetBusy(false);
  updateGoalBar();
  chatLoadList();
}
async function chatEnsureActive() {
  if (chatActiveId) return chatActiveId;
  const rec = await api.chatCreate();
  chatActiveId = rec.id;
  return chatActiveId;
}

// ---- goal / slash commands (Claude-Code-style) ----
const CHAT_GOAL_MAX = 30;
const CHAT_HELP =
  '**Commands**\n' +
  '- `/goal <objective>` — work autonomously toward a goal; I keep going across turns until I reply `GOAL COMPLETE`\n' +
  '- `/goal clear` — stop the goal\n' +
  '- `/agent [on|off]` — toggle Agent mode (write files, run commands, drive the browser)\n' +
  '- `/model <name>` — switch model\n' +
  '- `/clear` — start a new conversation\n' +
  '- `/stop` — stop the current run\n' +
  '- `/help` — this help\n\n' +
  '**What I can do**: enumerate a domain\'s subdomains (enum_subdomains, CT logs), read & replay all proxied traffic (list_flows/get_flow/search_flows/send_request), review captured JS, crawl a site and click through every page (crawl_site/browser_navigate/browser_click/browser_read_page) — in your own Chrome when the extension is connected — and, in **Agent mode**, write & run exploit/PoC code in the workspace.';

// The goal bar reflects the conversation currently on screen.
function updateGoalBar() {
  const bar = $('#chatGoalBar');
  const run = runs.get(chatActiveId);
  if (run && run.goal) {
    $('#chatGoalText').textContent = `${run.goal}  ·  iteration ${run.goalIter}`;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}
function clearGoal() {
  const run = runs.get(chatActiveId);
  if (run) run.goal = null;
  updateGoalBar();
}
function setGoal(text) {
  $('#chatAgentMode').checked = true; // goals run with full autonomy
  nextGoal = text; // attached to the run sendChat is about to create
  sendChat(
    `GOAL: ${text}\n\nWork autonomously toward this goal using every tool available ` +
      '(crawl/navigate the site, read & replay captured traffic, review JS, write and run code). ' +
      'Keep going across turns. When the goal is fully achieved, reply with "GOAL COMPLETE" on its own line, then a short summary.'
  );
}
// Continue a conversation's goal with a fresh background turn.
function goalContinueRun(run) {
  if (!run.goal || !runs.has(run.convId)) return;
  const note = 'Continue toward the goal. If it is fully achieved, reply "GOAL COMPLETE".';
  api.chatAppend(run.convId, { role: 'user', content: note });
  if (isActive(run.convId)) chatAppend('goal-note muted', `↻ continuing toward goal (iteration ${run.goalIter})`);
  launchTurn(run, note);
  chatLoadList();
}
function setChatModel(arg) {
  const q = (arg || '').toLowerCase();
  const m = modelList.find((x) => x.id.toLowerCase() === q)
    || modelList.find((x) => x.label.toLowerCase() === q)
    || modelList.find((x) => (x.id + ' ' + x.label).toLowerCase().includes(q) && q);
  if (m) {
    $('#chatModel').value = m.id;
    api.setSettings({ chatModel: m.id });
    toast('Model: ' + m.label);
  } else {
    toast('Unknown model: ' + arg);
  }
}
function handleSlash(raw) {
  const cmd = raw.slice(1).split(/\s+/)[0].toLowerCase();
  const arg = raw.slice(1 + cmd.length).trim();
  if (cmd === 'help') { chatAppend('assistant', chatMdLite(CHAT_HELP)); return true; }
  if (cmd === 'clear') { chatStartNew(); return true; }
  if (cmd === 'stop') { stopChat(); return true; }
  if (cmd === 'agent') {
    const on = arg ? /^(on|1|true|yes)$/i.test(arg) : !$('#chatAgentMode').checked;
    $('#chatAgentMode').checked = on;
    toast('Agent mode ' + (on ? 'on' : 'off'));
    return true;
  }
  if (cmd === 'model') { setChatModel(arg); return true; }
  if (cmd === 'goal') {
    if (!arg || /^clear$/i.test(arg)) { clearGoal(); toast('Goal cleared'); }
    else setGoal(arg);
    return true;
  }
  return false; // unknown slash -> send as a normal message
}

function chatRenderToolUse(name, input) {
  input = input || {};
  const n = String(name || '');
  if (n === 'TodoWrite' && Array.isArray(input.todos)) {
    const items = input.todos
      .map((t) => {
        const mark = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○';
        const cls = t.status === 'completed' ? 'todo-done' : t.status === 'in_progress' ? 'todo-active' : '';
        return `<div class="todo-item ${cls}">${mark} ${esc(t.content || t.activeForm || '')}</div>`;
      })
      .join('');
    return `<div class="chat-tool-name">⚙ To-dos</div><div class="chat-todos">${items}</div>`;
  }
  if (n === 'Task') {
    const sub = input.subagent_type || input.subagentType || 'subagent';
    const desc = input.description || input.prompt || '';
    return `<span class="chat-tool-name">🤖 Subagent → ${esc(sub)}</span>${desc ? ` <code>${esc(String(desc)).slice(0, 300)}</code>` : ''}`;
  }
  let label = n;
  let detail = '';
  if (n === 'Bash') detail = '$ ' + (input.command || '');
  else if (['Write', 'Edit', 'Read', 'NotebookEdit'].includes(n)) detail = input.file_path || input.path || '';
  else if (['Grep', 'Glob'].includes(n)) detail = input.pattern || input.query || '';
  else if (['WebFetch', 'WebSearch'].includes(n)) detail = input.url || input.query || '';
  else detail = JSON.stringify(input);
  detail = esc(String(detail)).slice(0, 500);
  return `<span class="chat-tool-name">⚙ ${esc(label)}</span>${detail ? ` <code>${detail}</code>` : ''}`;
}

// Fire a turn for `run` with the given message. Assigns a fresh turnId, routes
// it to the run's conversation, and shows the live status if that conversation
// is on screen (otherwise it runs silently in the background).
function launchTurn(run, message) {
  if (run.turnId) turnToConv.delete(run.turnId);
  chatTurnSeq += 1;
  run.turnId = `turn-${chatTurnSeq}`;
  turnToConv.set(run.turnId, run.convId);
  run.turnText = '';
  run.streamBuf = '';
  run.thinkBuf = '';
  run.stopped = false;
  run.word = randomWord();
  run.start = Date.now();
  if (isActive(run.convId)) { closeStreamActive(); chatSetBusy(true); startActiveStatus(run); }
  api.assistantSend({
    turnId: run.turnId,
    message,
    sessionId: run.sessionId,
    model: run.model,
    agentMode: run.agentMode,
  });
}

async function sendChat(explicitMsg) {
  const input = $('#chatInput');
  const typed = explicitMsg == null;
  const msg = typed ? input.value.trim() : explicitMsg;
  if (!msg) return;
  if (typed && msg.startsWith('/') && handleSlash(msg)) { input.value = ''; return; }
  // Don't start a second turn in a conversation that's already working.
  if (runs.has(chatActiveId)) { toast('This chat is already working — open or create another chat to run in parallel'); return; }
  if (typed) input.value = '';
  const convId = await chatEnsureActive();
  await api.chatAppend(convId, { role: 'user', content: msg });
  chatAppend('user', esc(msg).replace(/\n/g, '<br>'));
  const run = makeRun(convId);
  if (nextGoal) { run.goal = nextGoal; run.goalIter = 0; nextGoal = null; }
  runs.set(convId, run);
  launchTurn(run, msg);
  updateGoalBar();
  chatLoadList();
}

$('#chatSendBtn').addEventListener('click', () => {
  if (runs.has(chatActiveId)) stopChat();
  else sendChat();
});
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    if (!runs.has(chatActiveId)) sendChat();
  }
  // Esc interrupts the on-screen conversation's response (Claude-Code-style).
  if (e.key === 'Escape' && runs.has(chatActiveId)) {
    e.preventDefault();
    stopChat();
  }
});
$('#chatStopBtn').addEventListener('click', stopChat);
$('#chatGoalClear').addEventListener('click', () => { clearGoal(); toast('Goal cleared'); });
$('#chatNewBtn').addEventListener('click', () => { chatStartNew(); });
$('#chatAuditAllBtn').addEventListener('click', () => {
  if (runs.has(chatActiveId)) { toast('This chat is already working — open another chat'); return; }
  $('#chatAgentMode').checked = true;
  sendChat(AUDIT_ALL_PROMPT);
});

if ($('#chatSubdomainsBtn')) {
  $('#chatSubdomainsBtn').addEventListener('click', () => {
    if (runs.has(chatActiveId)) { toast('This chat is already working — open another chat'); return; }
    const domain = (window.prompt('Enumerate subdomains for which domain? (you must be authorized to test it)') || '').trim();
    if (!domain) return;
    sendChat(
      `Enumerate the subdomains of ${domain} with enum_subdomains, list what you find, then audit the discovered hosts: ` +
      `for each one, navigate/crawl it through the browser so its traffic is captured, and review it with list_flows/get_flow/list_js_files. ` +
      `Report findings per host with evidence, severity, and remediation. This is authorized testing of ${domain} and its subdomains.`
    );
  });
}

// ---- Chrome-extension control channel: use the user's own Chrome as the
// agent's browser. The chip shows connection state; clicking it when the
// extension isn't connected reveals the folder to load unpacked in Chrome.
function renderExtStatus(st) {
  const el = $('#chatExtState');
  const chip = $('#chatExtChip');
  if (!el || !chip) return;
  const connected = !!(st && st.connected);
  el.textContent = connected ? 'connected' : 'not connected';
  chip.classList.toggle('ok', connected);
  chip.title = connected
    ? 'Your Chrome is the agent\'s browser (ProxyAudit extension connected).'
    : 'Click for setup — load the ProxyAudit extension in Chrome to let the agent drive your own browser.';
}
async function refreshExtStatus() {
  try { renderExtStatus(await api.extensionStatus()); } catch (_) {}
}
if ($('#chatExtChip')) {
  $('#chatExtChip').addEventListener('click', async () => {
    let st = {};
    try { st = await api.extensionStatus(); } catch (_) {}
    if (st && st.connected) {
      chatAppend('assistant muted', '🧩 The ProxyAudit extension is connected — I\'ll drive your Chrome (navigate, read pages, click) for authorized testing. Traffic is captured through the proxy.');
      return;
    }
    let dir = '';
    try { const r = await api.extensionReveal(); dir = (r && r.dir) || ''; } catch (_) {}
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    chatAppend('assistant muted',
      '<div style="white-space:pre-wrap">🧩 Set up the ProxyAudit extension so I can use your own Chrome:\n' +
      '1. Open chrome://extensions\n' +
      '2. Turn on "Developer mode" (top-right)\n' +
      '3. Click "Load unpacked" and choose:\n   ' + esc(dir || 'the ProxyAudit "extension" folder') + '\n' +
      '4. Keep that Chrome open — the extension badge turns green when connected.\n' +
      'Then use the extension popup\'s "Toggle proxy routing" so your browsing is captured.</div>');
  });
}
api.on('extension:status', renderExtStatus);
refreshExtStatus();
setInterval(refreshExtStatus, 4000);

// Route every assistant event to the conversation whose turn produced it.
// Persist to that conversation's store always; render to the DOM only when it
// is the conversation currently on screen. Background turns thus keep running
// and streaming into their own history while the user works elsewhere.
api.on('evt:assistant-event', ({ turnId, event }) => {
  const convId = turnToConv.get(turnId);
  if (!convId) return; // stale/stopped/unknown turn
  const run = runs.get(convId);
  if (!run) return;
  const active = isActive(convId);
  if (active) chatClearPending();

  if (event.type === 'text') {
    run.turnText += event.text;
    run.streamBuf += event.text;
    if (active) {
      closeThinkActive(run);
      if (!actStreamEl) actStreamEl = chatAppend('assistant', '');
      actStreamEl.innerHTML = chatMdLite(run.streamBuf);
      scrollMessages();
    }
  } else if (event.type === 'thinking') {
    if (!event.text) return;
    run.thinkBuf += event.text;
    if (active) {
      if (!actThinkEl) actThinkEl = chatAppend('thinking muted', '');
      actThinkEl.textContent = '💭 ' + run.thinkBuf.slice(-4000);
      scrollMessages();
    }
  } else if (event.type === 'tool_use') {
    flushSegment(run); // persist any assistant text before the tool call
    api.chatAppend(convId, {
      role: 'tool',
      content: JSON.stringify(event.input || {}).slice(0, 2000),
      meta: { name: event.name },
    });
    if (active) { closeThinkActive(run); closeStreamActive(); chatAppend('tool', chatRenderToolUse(event.name, event.input)); }
  } else if (event.type === 'tool_result') {
    api.chatAppend(convId, { role: 'tool_result', content: (event.text || '').slice(0, 4000) });
    if (active) { closeThinkActive(run); closeStreamActive(); chatAppend('tool-result', `<pre class="chat-code">${esc(event.text)}</pre>`); }
  } else if (event.type === 'done') {
    finishRun(run, event);
  }
});

// Finalise a turn: persist the last text, update the session, run the goal loop,
// and release the run (unless it continues toward a goal).
function finishRun(run, event) {
  const active = isActive(run.convId);
  flushSegment(run);
  if (event.sessionId) {
    run.sessionId = event.sessionId;
    api.chatSetSession(run.convId, event.sessionId);
    if (active) chatSessionId = event.sessionId;
  }
  if (active) { closeThinkActive(run); finishActiveStatus(run, run.stopped); chatSetBusy(false); }

  if (event.error) {
    api.chatAppend(run.convId, { role: 'assistant', content: event.error, meta: { error: true } });
    if (active) chatAppend('assistant error', '⚠ ' + esc(event.error));
    run.goal = null;
  }

  let continued = false;
  if (!event.error && run.goal) {
    if (/GOAL\s*COMPLETE/i.test(run.turnText)) {
      if (active) toast('🎯 Goal complete');
      run.goal = null;
    } else if (run.goalIter < CHAT_GOAL_MAX) {
      run.goalIter += 1;
      continued = true;
      setTimeout(() => goalContinueRun(run), 500);
    } else {
      if (active) toast('🎯 Goal: reached max iterations');
      run.goal = null;
    }
  }

  if (!continued) {
    runs.delete(run.convId);
    turnToConv.delete(run.turnId);
  }
  if (active) updateGoalBar();
  chatLoadList();
}

// ============================ settings ============================
$('#revealCaBtn').addEventListener('click', () => api.revealCa());

// ---- mobile interception setup ----
async function refreshMobile() {
  let info = null;
  try { info = await api.mobileInfo(); } catch (_) { return; }
  if (!info) return;
  const box = $('#mobileSetup');
  $('#mobileLan').checked = !!info.enabled;
  if (info.enabled) box.classList.remove('hidden');
  else box.classList.add('hidden');
  const primary = (info.lan && info.lan[0] && info.lan[0].address) || 'your-computer-ip';
  $('#mobileHost').textContent = primary;
  $('#mobilePort').textContent = info.port;
  // List every LAN address so the user can pick the right interface.
  if (info.lan && info.lan.length > 1) {
    $('#mobileHost').textContent = info.lan.map((a) => a.address).join('  /  ');
  }
  const warn = $('#mobileWarn');
  if (info.enabled && !info.running) warn.textContent = '⚠ Start the proxy for devices to connect.';
  else if (info.enabled && info.boundHost !== '0.0.0.0') warn.textContent = '⚠ Restart the proxy to bind to the network.';
  else warn.textContent = '';
}
$('#mobileLan').addEventListener('change', async (e) => {
  const on = e.target.checked;
  await api.mobileSetLan(on);
  toast(on ? 'Proxy now reachable on your network' : 'Proxy restricted to this computer');
  await refreshMobile();
});
$('#setPort').addEventListener('change', async (e) => {
  await api.setSettings({ port: Number(e.target.value) });
  toast('Port saved — restart the proxy to apply');
});
$('#setModel').addEventListener('change', async (e) => {
  await api.setSettings({ model: e.target.value });
  toast('Model set to ' + e.target.value);
});
async function recheckAuth() {
  setAuthUi('checking');
  const s = await api.authStatus();
  if (s && s.loggedIn) {
    const plan = s.subscriptionType ? ` · ${s.subscriptionType}` : '';
    setAuthUi('ok', `Signed in as ${s.email || 'your account'}${plan}`);
  } else {
    setAuthUi('bad', s && s.error ? s.error : null);
  }
}
$('#recheckAuthBtn2').addEventListener('click', recheckAuth);

$('#authLoginBtn').addEventListener('click', async () => {
  const btn = $('#authLoginBtn');
  btn.disabled = true;
  $('#authDetail').textContent = 'Opening Chrome to sign in…';
  setAuthUi('checking');
  const r = await api.authLogin();
  btn.disabled = false;
  if (r.ok) toast('Signed in');
  else toast('⚠ Sign-in did not complete' + (r.error ? ': ' + r.error : ''), 5000);
  recheckAuth();
});
$('#authLogoutBtn').addEventListener('click', async () => {
  await api.authLogout();
  toast('Signed out');
  recheckAuth();
});
api.on('evt:auth-login', (line) => {
  if (typeof line === 'string' && line.startsWith('__URL__')) {
    $('#authDetail').innerHTML =
      'Opening Chrome… if it does not open, visit: <code>' + esc(line.slice(7)) + '</code>';
  }
});

function setAuthUi(state, detail) {
  const el = $('#authStatus');
  const txt = $('#authText');
  const loginBtn = $('#authLoginBtn');
  const logoutBtn = $('#authLogoutBtn');
  el.className = 'auth-status ' + (state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : 'unknown');
  if (state === 'ok') {
    txt.textContent = 'Claude: signed in';
    $('#authDetail').textContent = detail || 'Signed in.';
    if (loginBtn) loginBtn.classList.add('hidden');
    if (logoutBtn) logoutBtn.classList.remove('hidden');
  } else if (state === 'bad') {
    txt.textContent = 'Claude: signed out';
    $('#authDetail').textContent = detail
      ? 'Not signed in: ' + detail
      : 'Not signed in. Click “Sign in with Chrome”.';
    if (loginBtn) loginBtn.classList.remove('hidden');
    if (logoutBtn) logoutBtn.classList.add('hidden');
  } else if (state === 'checking') {
    txt.textContent = 'Claude: checking…';
    $('#authDetail').textContent = 'Checking…';
  } else {
    txt.textContent = 'Claude: unknown';
  }
}

// ============================= events =============================
api.on('evt:status', applyStatus);
api.on('evt:error', (msg) => toast('⚠ ' + msg));
api.on('evt:cleared', () => {
  flows.clear();
  renderFlowTable();
});
api.on('evt:flow', (summary) => {
  flows.set(summary.id, summary);
  scheduleRender();
});
api.on('evt:flow-update', (summary) => {
  flows.set(summary.id, summary);
  scheduleRender();
  if (summary.id === selectedFlowId) selectFlow(summary.id);
});
api.on('evt:intercept', (flow) => {
  interceptQueue.push(flow);
  refreshInterceptView();
  if (interceptQueue.length === 1) showView('intercept');
});
api.on('evt:ws-open', (conn) => {
  wsConns.set(conn.id, { ...conn, closed: false, messages: [] });
  renderWsList();
});
api.on('evt:ws-message', async ({ connId }) => {
  if (connId === selectedWs) {
    const conn = await api.getWs(connId);
    renderWsFrames(conn);
  }
});
api.on('evt:ws-close', (connId) => {
  const c = wsConns.get(connId);
  if (c) c.closed = true;
  renderWsList();
});

// ========================= target / sitemap ======================
const sitemap = SiteMap.mount($('#smTree'), { onSelect: selectSitemapNode });
const smReqViewer = MsgView.mount($('#smReqView'));
const smResViewer = MsgView.mount($('#smResView'));
let smSelectedContentId = null;
function renderSitemap() {
  sitemap.update(flows);
}
let smRenderScheduled = false;
function scheduleSitemapRender() {
  if (smRenderScheduled) return;
  smRenderScheduled = true;
  requestAnimationFrame(() => {
    smRenderScheduled = false;
    renderSitemap();
  });
}
// SiteMap hands us a flow id; TargetView derives the host+path subtree and
// lists every flow under it in the contents table.
function selectSitemapNode(flowId) {
  sitemap.select(flowId);
  $('#smContents').innerHTML = TargetView.renderRows(TargetView.rowsForNode(flows, flowId), smSelectedContentId);
  if (flowId != null) loadSitemapFlow(flowId);
}
async function loadSitemapFlow(id) {
  smSelectedContentId = id;
  $$('#smContents tr').forEach((tr) => tr.classList.toggle('selected', tr.dataset.id === String(id)));
  const flow = await api.getFlow(id);
  if (!flow) return;
  currentFlow = flow;
  smReqViewer.setMessage(buildRequestRaw(flow));
  smResViewer.setMessage(buildResponseRaw(flow));
}
$('#smContents').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (tr && tr.dataset.id) loadSitemapFlow(tr.dataset.id);
});
$$('.sm-seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.sm-seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('#smReqView').classList.toggle('hidden', b.dataset.pane !== 'req');
    $('#smResView').classList.toggle('hidden', b.dataset.pane !== 'res');
  })
);
api.on('evt:flow', () => {
  if ($('#view-sitemap').classList.contains('active')) scheduleSitemapRender();
});
api.on('evt:flow-update', () => {
  if ($('#view-sitemap').classList.contains('active')) scheduleSitemapRender();
});

// ============================ intruder ============================
let intrAttackId = null;
let intrPositions = 0;
const intrRows = new Map();
let intrSelected = null;
let intrDetailPane = 'req';

// One payload config per set: { type, params:{}, processing:[{type,enabled,...}], encoding:{chars} }
let intrConfigs = [];
let intrActiveSet = 0;
let intrTotal = 0;
const INTR_RULE_LABELS = {
  'add-prefix': 'Add prefix', 'add-suffix': 'Add suffix', 'match-replace': 'Match/replace',
  'substring': 'Substring', 'modify-case': 'Modify case', 'encode': 'Encode',
  'decode': 'Decode', 'hash': 'Hash', 'skip-if-match': 'Skip if matches',
};
function intrDefaultConfig() {
  return { type: 'simple-list', params: { items: '' }, processing: [], encoding: { chars: '' } };
}
function intrPayloadSetCount() {
  const t = $('#intrAttackType').value;
  if (t === 'sniper' || t === 'batteringram') return 1;
  return Math.max(1, intrPositions);
}
function intrParsePositions(tpl) {
  const segs = String(tpl).replace(/\r\n/g, '\n').split('§');
  const n = Math.floor((segs.length - 1) / 2);
  return n < 0 ? 0 : n;
}
function intrEnsureConfigs() {
  const n = intrPayloadSetCount();
  while (intrConfigs.length < n) intrConfigs.push(intrDefaultConfig());
  if (intrConfigs.length > n) intrConfigs.length = n;
  if (intrActiveSet >= n) intrActiveSet = 0;
  return n;
}
function intrRenderSetSelect() {
  const n = intrConfigs.length;
  const row = $('#intrSetSelectRow');
  if (n <= 1) { row.style.display = 'none'; return; }
  row.style.display = '';
  const sel = $('#intrSetSelect');
  sel.innerHTML = intrConfigs
    .map((_, i) => `<option value="${i}">Set ${i + 1} (position ${i + 1})</option>`).join('');
  sel.value = String(intrActiveSet);
}
function intrRenderParams() {
  const cfg = intrConfigs[intrActiveSet];
  const p = cfg.params || (cfg.params = {});
  const wrap = $('#intrParams');
  const v = (x) => (x == null ? '' : esc(String(x)));
  let html = '';
  if (cfg.type === 'simple-list' || cfg.type === 'case-modification') {
    html +=
      `<textarea class="code-area" data-param="items" spellcheck="false" style="min-height:90px" placeholder="one payload per line">${v(p.items)}</textarea>` +
      `<div class="intr-row">` +
        `<input class="input grow" id="intrListAdd" placeholder="add an item…" />` +
        `<button class="btn sm" id="intrListAddBtn">Add</button>` +
        `<button class="btn sm" id="intrListClearBtn">Clear</button>` +
      `</div>`;
    if (cfg.type === 'case-modification') {
      html += `<div class="intr-row"><span class="field-label">Mode</span><select class="input" data-param="mode">` +
        ['all', 'lower', 'upper', 'capitalize'].map((m) => `<option value="${m}"${(p.mode || 'all') === m ? ' selected' : ''}>${m}</option>`).join('') +
        `</select></div>`;
    }
  } else if (cfg.type === 'numbers') {
    html +=
      `<div class="intr-row"><span class="field-label">From</span><input class="input" style="width:80px" data-param="from" type="number" value="${v(p.from)}" placeholder="1" />` +
      `<span class="field-label">To</span><input class="input" style="width:80px" data-param="to" type="number" value="${v(p.to)}" placeholder="100" />` +
      `<span class="field-label">Step</span><input class="input" style="width:70px" data-param="step" type="number" value="${v(p.step)}" placeholder="1" /></div>` +
      `<div class="intr-row"><span class="field-label">Format</span><input class="input grow" data-param="format" value="${v(p.format)}" placeholder="optional: 0000 (zero-pad) or hex" /></div>`;
  } else if (cfg.type === 'dates') {
    html +=
      `<div class="intr-row"><span class="field-label">From</span><input class="input" data-param="from" type="date" value="${v(p.from)}" />` +
      `<span class="field-label">To</span><input class="input" data-param="to" type="date" value="${v(p.to)}" /></div>` +
      `<div class="intr-row"><span class="field-label">Step (days)</span><input class="input" style="width:70px" data-param="stepDays" type="number" value="${v(p.stepDays)}" placeholder="1" />` +
      `<span class="field-label">Format</span><input class="input grow" data-param="format" value="${v(p.format)}" placeholder="YYYY-MM-DD" /></div>`;
  } else if (cfg.type === 'brute-forcer') {
    html +=
      `<div class="intr-row"><span class="field-label">Charset</span><input class="input grow" data-param="charset" value="${v(p.charset)}" placeholder="abc…0123456789" /></div>` +
      `<div class="intr-row"><span class="field-label">Min length</span><input class="input" style="width:70px" data-param="minLen" type="number" value="${v(p.minLen)}" placeholder="1" />` +
      `<span class="field-label">Max length</span><input class="input" style="width:70px" data-param="maxLen" type="number" value="${v(p.maxLen)}" placeholder="3" /></div>`;
  } else if (cfg.type === 'null-payloads') {
    html += `<div class="intr-row"><span class="field-label">Count</span><input class="input" style="width:90px" data-param="count" type="number" value="${v(p.count)}" placeholder="10" /></div>`;
  }
  wrap.innerHTML = html;
  wrap.querySelectorAll('[data-param]').forEach((el) => {
    const ev = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(ev, () => { p[el.dataset.param] = el.value; updateIntrCount(); });
  });
  const addBtn = $('#intrListAddBtn');
  if (addBtn) {
    const ta = wrap.querySelector('[data-param="items"]');
    const inp = $('#intrListAdd');
    addBtn.addEventListener('click', () => {
      const val = inp.value.trim();
      if (!val) return;
      ta.value = (ta.value ? ta.value.replace(/\n$/, '') + '\n' : '') + val;
      p.items = ta.value; inp.value = ''; updateIntrCount();
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
    $('#intrListClearBtn').addEventListener('click', () => { ta.value = ''; p.items = ''; updateIntrCount(); });
  }
}
function intrRuleSummary(r) {
  switch (r.type) {
    case 'add-prefix': return `prefix "${r.text || ''}"`;
    case 'add-suffix': return `suffix "${r.text || ''}"`;
    case 'match-replace': return `s/${r.regex || ''}/${r.replace || ''}/${r.flags == null ? 'g' : r.flags}`;
    case 'substring': return `substring ${r.from || 0}${r.length ? ',' + r.length : '..'}`;
    case 'modify-case': return `case → ${r.mode || 'lower'}`;
    case 'encode': return `encode ${r.kind || 'url'}`;
    case 'decode': return `decode ${r.kind || 'url'}`;
    case 'hash': return `hash ${r.algo || 'sha256'}`;
    case 'skip-if-match': return `skip /${r.regex || ''}/`;
    default: return r.type;
  }
}
function intrRuleFieldsHtml(r) {
  const v = (x) => (x == null ? '' : esc(String(x)));
  const sel = (field, cur, arr) => `<select class="input" data-field="${field}">` +
    arr.map((o) => `<option value="${o}"${cur === o ? ' selected' : ''}>${o}</option>`).join('') + `</select>`;
  switch (r.type) {
    case 'add-prefix':
    case 'add-suffix': return `<input class="input grow" data-field="text" value="${v(r.text)}" placeholder="text" />`;
    case 'match-replace':
      return `<input class="input" style="flex:2" data-field="regex" value="${v(r.regex)}" placeholder="regex" />` +
             `<input class="input" style="width:60px" data-field="flags" value="${v(r.flags == null ? 'g' : r.flags)}" placeholder="flags" />` +
             `<input class="input" style="flex:1" data-field="replace" value="${v(r.replace)}" placeholder="replacement" />`;
    case 'substring':
      return `<span class="field-label">From</span><input class="input" style="width:70px" data-field="from" type="number" value="${v(r.from)}" />` +
             `<span class="field-label">Length</span><input class="input" style="width:80px" data-field="length" type="number" value="${v(r.length)}" placeholder="to end" />`;
    case 'modify-case': return sel('mode', r.mode || 'lower', ['lower', 'upper', 'capitalize']);
    case 'encode': return sel('kind', r.kind || 'url', ['url', 'url-all', 'base64', 'html']);
    case 'decode': return sel('kind', r.kind || 'url', ['url', 'base64']);
    case 'hash': return sel('algo', r.algo || 'sha256', ['md5', 'sha1', 'sha256']);
    case 'skip-if-match': return `<input class="input grow" data-field="regex" value="${v(r.regex)}" placeholder="regex (drop matches)" />`;
    default: return '';
  }
}
function intrRenderRules() {
  const cfg = intrConfigs[intrActiveSet];
  const rules = cfg.processing || (cfg.processing = []);
  const wrap = $('#intrRules');
  if (!rules.length) {
    wrap.innerHTML = '<div class="muted" style="padding:4px 0">No processing rules — payloads used as-is.</div>';
    return;
  }
  wrap.innerHTML = rules.map((r, i) =>
    `<div class="intr-rule" data-i="${i}">` +
      `<label class="switch" title="Enabled" style="margin:0"><input type="checkbox" data-act="enabled"${r.enabled !== false ? ' checked' : ''}/><span class="slider"></span></label>` +
      `<select class="input" data-act="type" style="width:130px">` +
        Object.keys(INTR_RULE_LABELS).map((k) => `<option value="${k}"${r.type === k ? ' selected' : ''}>${INTR_RULE_LABELS[k]}</option>`).join('') +
      `</select>` +
      `<div class="intr-rule-fields">${intrRuleFieldsHtml(r)}</div>` +
      `<span class="intr-rule-sum">${esc(intrRuleSummary(r))}</span>` +
      `<button class="btn sm" data-act="up"${i === 0 ? ' disabled' : ''}>▲</button>` +
      `<button class="btn sm" data-act="down"${i === rules.length - 1 ? ' disabled' : ''}>▼</button>` +
      `<button class="btn sm" data-act="remove">✕</button>` +
    `</div>`).join('');
  wrap.querySelectorAll('.intr-rule').forEach((row) => {
    const i = Number(row.dataset.i);
    const r = rules[i];
    row.querySelector('[data-act="enabled"]').addEventListener('change', (e) => { r.enabled = e.target.checked; updateIntrCount(); });
    row.querySelector('[data-act="type"]').addEventListener('change', (e) => { r.type = e.target.value; intrRenderRules(); updateIntrCount(); });
    row.querySelector('[data-act="up"]').addEventListener('click', () => { if (i > 0) { [rules[i - 1], rules[i]] = [rules[i], rules[i - 1]]; intrRenderRules(); updateIntrCount(); } });
    row.querySelector('[data-act="down"]').addEventListener('click', () => { if (i < rules.length - 1) { [rules[i + 1], rules[i]] = [rules[i], rules[i + 1]]; intrRenderRules(); updateIntrCount(); } });
    row.querySelector('[data-act="remove"]').addEventListener('click', () => { rules.splice(i, 1); intrRenderRules(); updateIntrCount(); });
    row.querySelectorAll('[data-field]').forEach((el) => {
      const ev = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => {
        r[el.dataset.field] = el.value;
        const sum = row.querySelector('.intr-rule-sum'); if (sum) sum.textContent = intrRuleSummary(r);
        updateIntrCount();
      });
    });
  });
}
function intrLoadActive() {
  const cfg = intrConfigs[intrActiveSet];
  $('#intrPayloadType').value = cfg.type;
  $('#intrEncChars').value = (cfg.encoding && cfg.encoding.chars) || '';
  intrRenderParams();
  intrRenderRules();
}
let intrLastSetCount = -1;
function intrSyncSets() {
  const n = intrEnsureConfigs();
  intrRenderSetSelect();
  if (n !== intrLastSetCount) { intrLastSetCount = n; intrLoadActive(); }
}
async function updateIntrCount() {
  intrPositions = intrParsePositions($('#intrTemplate').value);
  intrSyncSets();
  const res = await api.intruderCount({
    attackType: $('#intrAttackType').value,
    template: $('#intrTemplate').value,
    payloadSets: intrConfigs,
  });
  intrTotal = res.total;
  const warn = res.total > 5000 ? '  ⚠ large run' : '';
  $('#intrCount').textContent = `${res.positions} position(s) · ${res.total} request(s)${warn}`;
}
$('#intrTemplate').addEventListener('input', updateIntrCount);
$('#intrAttackType').addEventListener('change', () => { intrLastSetCount = -1; updateIntrCount(); });
$('#intrPayloadType').addEventListener('change', () => {
  intrConfigs[intrActiveSet].type = $('#intrPayloadType').value;
  intrRenderParams(); updateIntrCount();
});
$('#intrSetSelect').addEventListener('change', () => {
  intrActiveSet = Number($('#intrSetSelect').value) || 0;
  intrLoadActive();
});
$('#intrEncChars').addEventListener('input', () => {
  intrConfigs[intrActiveSet].encoding = { chars: $('#intrEncChars').value };
  updateIntrCount();
});
$('#intrRuleAdd').addEventListener('click', () => {
  intrConfigs[intrActiveSet].processing.push({ type: $('#intrRuleType').value, enabled: true });
  intrRenderRules(); updateIntrCount();
});
$('#intrMarkBtn').addEventListener('click', () => {
  const ta = $('#intrTemplate');
  const s = ta.selectionStart, e = ta.selectionEnd, val = ta.value;
  const selTxt = val.slice(s, e) || 'payload';
  ta.value = val.slice(0, s) + '§' + selTxt + '§' + val.slice(e);
  ta.focus(); ta.selectionStart = s + 1; ta.selectionEnd = s + 1 + selTxt.length;
  updateIntrCount();
});
function renderIntrRow(r) {
  const payload = esc(Array.isArray(r.payloads) ? r.payloads.join(' · ') : '');
  const stat = r.error ? '—' : (r.status || '');
  return (
    `<tr data-i="${r.index}" class="${r.index === intrSelected ? 'selected' : ''}">` +
    `<td class="muted">${r.index}</td>` +
    `<td title="${payload}">${payload}</td>` +
    `<td class="${statusClass(r.status)}" title="${esc(r.error || '')}">${esc(stat)}</td>` +
    `<td class="muted">${r.error ? '' : fmtLen(r.length)}</td>` +
    `<td class="muted">${r.durationMs != null ? r.durationMs + ' ms' : ''}</td>` +
    `</tr>`
  );
}
let intrRenderScheduled = false;
function renderIntrTable() {
  intrRenderScheduled = false;
  const rows = Array.from(intrRows.values()).sort((a, b) => a.index - b.index);
  $('#intrBody').innerHTML = rows.map(renderIntrRow).join('');
}
function scheduleIntrRender() {
  if (intrRenderScheduled) return;
  intrRenderScheduled = true;
  requestAnimationFrame(renderIntrTable);
}
$('#intrBody').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  intrSelected = Number(tr.dataset.i);
  $$('#intrBody tr').forEach((x) =>
    x.classList.toggle('selected', Number(x.dataset.i) === intrSelected)
  );
  const full = await api.intruderResult(intrAttackId, intrSelected);
  if (!full) return;
  const req = full.request || {};
  const res = full.response || {};
  const reqRaw =
    `${req.method} ${req.url}\n` +
    Object.entries(req.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n') +
    '\n\n' + (req.body || '');
  const resRaw = res.error
    ? 'Error: ' + res.error
    : `HTTP ${res.status} ${res.statusMessage || ''}\n` +
      Object.entries(res.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n') +
      '\n\n' + (res.body || '');
  $('#intrReqRaw').textContent = reqRaw;
  $('#intrResRaw').textContent = resRaw;
  $('#intrDetailMeta').textContent = res.error
    ? ''
    : `${res.status} · ${fmtLen(res.length)} · ${res.durationMs} ms`;
});
$$('#view-intruder .seg-btn').forEach((b) =>
  b.addEventListener('click', () => {
    intrDetailPane = b.dataset.ipane;
    $$('#view-intruder .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    $('#intrReqRaw').classList.toggle('hidden', intrDetailPane !== 'req');
    $('#intrResRaw').classList.toggle('hidden', intrDetailPane !== 'res');
  })
);
$('#intrStartBtn').addEventListener('click', async () => {
  const origin = $('#intrTarget').value.trim();
  const template = $('#intrTemplate').value;
  if (!origin) return toast('Enter a target origin (scheme://host)');
  if (!template.trim()) return toast('Enter a request template');
  if (!intrTotal) return toast('No payloads — check your payload configuration');
  intrRows.clear();
  intrSelected = null;
  renderIntrTable();
  $('#intrReqRaw').textContent = 'Running…';
  $('#intrResRaw').textContent = '';
  const res = await api.intruderStart({
    origin,
    template,
    attackType: $('#intrAttackType').value,
    payloadSets: intrConfigs,
    concurrency: 10,
  });
  intrAttackId = res.attackId;
  $('#intrStartBtn').disabled = true;
  $('#intrStopBtn').disabled = false;
  $('#intrCount').textContent = `0 / ${res.total}`;
});
$('#intrStopBtn').addEventListener('click', () => {
  if (intrAttackId) api.intruderStop(intrAttackId);
});
api.on('evt:intruder-result', ({ attackId, row }) => {
  if (attackId !== intrAttackId) return;
  intrRows.set(row.index, row);
  scheduleIntrRender();
});
api.on('evt:intruder-progress', ({ attackId, done, total }) => {
  if (attackId !== intrAttackId) return;
  $('#intrCount').textContent = `${done} / ${total}`;
});
api.on('evt:intruder-done', ({ attackId, done, total, stopped }) => {
  if (attackId !== intrAttackId) return;
  $('#intrStartBtn').disabled = false;
  $('#intrStopBtn').disabled = true;
  $('#intrCount').textContent = `${done} / ${total}${stopped ? ' (stopped)' : ' (done)'}`;
  toast(stopped ? 'Attack stopped' : 'Attack finished');
});
function sendFlowToIntruder(flow) {
  $('#intrTarget').value = `${flow.scheme}://${flow.host}`;
  const headers = flow.request
    ? Object.entries(flow.request.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '';
  $('#intrTemplate').value =
    `${flow.method} ${flow.path} HTTP/1.1\n${headers}\n\n` +
    (flow.request && flow.request.body ? flow.request.body : '');
  showView('intruder');
  updateIntrCount();
  toast('Sent to Intruder — wrap a value in § to mark a position');
}
$('#toIntruderBtn').addEventListener('click', () => {
  const flow = selectFlow._current;
  if (flow) sendFlowToIntruder(flow);
});
updateIntrCount();

// ============================ comparer ============================
let cmpMode = 'line';
function renderCompare() {
  const a = $('#cmpA').value;
  const b = $('#cmpB').value;
  const segs = window.DiffUtil.diff(a, b, cmpMode);
  const html = segs
    .map((s) => {
      const cls = s.type === 'ins' ? 'diff-ins' : s.type === 'del' ? 'diff-del' : 'diff-eq';
      return `<span class="${cls}">${esc(s.text)}</span>`;
    })
    .join('');
  const out = $('#cmpResult');
  if (!a && !b) {
    out.textContent = 'Enter text in A and B, then Compare.';
    $('#cmpStats').textContent = '';
    return;
  }
  out.innerHTML = html || '<span class="muted">(no differences)</span>';
  const st = window.DiffUtil.stats(segs);
  $('#cmpStats').textContent = `+${st.ins} / −${st.del} chars · ${cmpMode}-level`;
}
$('#cmpCompareBtn').addEventListener('click', renderCompare);
$('#cmpModeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('.seg-btn');
  if (!b) return;
  cmpMode = b.dataset.cmode;
  $$('#cmpModeSeg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
  renderCompare();
});
$('#cmpSwapBtn').addEventListener('click', () => {
  const a = $('#cmpA').value;
  $('#cmpA').value = $('#cmpB').value;
  $('#cmpB').value = a;
  renderCompare();
});
$('#cmpClearBtn').addEventListener('click', () => {
  $('#cmpA').value = '';
  $('#cmpB').value = '';
  renderCompare();
});
window.sendToComparer = function (text, slot) {
  $(slot === 'b' ? '#cmpB' : '#cmpA').value = String(text == null ? '' : text);
  showView('comparer');
  renderCompare();
  toast('Sent to Comparer (' + (slot === 'b' ? 'B' : 'A') + ')');
};

// ============================= decoder ============================
(function initDecoder() {
  const chain = $('#decoderChain');
  if (!chain) return;
  function optionsHtml() {
    return (
      '<option value="">— pick transform —</option>' +
      window.Transforms.list.map((t) => `<option value="${t.id}">${esc(t.label)}</option>`).join('')
    );
  }
  const firstPick = chain.querySelector('.decoder-pick');
  firstPick.innerHTML = optionsHtml();
  function pruneAfter(fromStep) {
    let n = fromStep.nextElementSibling;
    while (n) {
      const next = n.nextElementSibling;
      n.remove();
      n = next;
    }
  }
  function inputValueOf(step) {
    const inputEl = step.querySelector('.decoder-input');
    if (inputEl) return inputEl.value;
    return step.dataset.output || '';
  }
  async function runStep(step) {
    const pick = step.querySelector('.decoder-pick');
    const id = pick.value;
    pruneAfter(step);
    const existing = step.querySelector('.decoder-output-wrap');
    if (existing) existing.remove();
    if (!id) return;
    const input = inputValueOf(step);
    let output, failed = false;
    try {
      output = await window.Transforms.apply(id, input);
    } catch (e) {
      output = '⚠ ' + e.message;
      failed = true;
    }
    step.dataset.output = failed ? '' : output;
    const wrap = document.createElement('div');
    wrap.className = 'decoder-output-wrap';
    wrap.style.cssText = 'display:flex; flex-direction:column; gap:6px; margin-top:4px;';
    wrap.innerHTML =
      '<div style="display:flex; align-items:center; gap:8px;">' +
      `<label class="field-label">Output${failed ? ' (error)' : ''}</label>` +
      '<div class="spacer"></div>' +
      '<button class="btn sm decoder-copy">Copy</button>' +
      '</div>' +
      '<textarea class="code-area decoder-out" readonly spellcheck="false" style="flex:none; min-height:110px;"></textarea>';
    wrap.querySelector('.decoder-out').value = output;
    wrap.querySelector('.decoder-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(output).then(() => toast('Copied'), () => toast('Copy failed'));
    });
    step.appendChild(wrap);
    if (!failed) appendNextStep(step);
  }
  function appendNextStep(step) {
    if (step.querySelector('.decoder-add')) return;
    const addRow = document.createElement('div');
    addRow.className = 'decoder-add';
    addRow.style.cssText = 'margin-top:2px;';
    addRow.innerHTML = '<button class="btn sm">+ add step</button>';
    addRow.querySelector('button').addEventListener('click', () => {
      addRow.remove();
      const next = makeStep(step.dataset.output || '');
      chain.appendChild(next);
      next.querySelector('.decoder-pick').focus();
    });
    step.appendChild(addRow);
  }
  function makeStep(inputText) {
    const step = document.createElement('div');
    step.className = 'decoder-step';
    step.dataset.input = inputText;
    step.style.cssText = 'display:flex; flex-direction:column; gap:6px; border-top:1px solid var(--line); padding-top:10px;';
    step.innerHTML =
      '<div style="display:flex; align-items:center; gap:8px;">' +
      '<label class="field-label">Then</label>' +
      '<div class="spacer"></div>' +
      `<select class="input decoder-pick" style="width:200px">${optionsHtml()}</select>` +
      '</div>';
    step.querySelector('.decoder-pick').addEventListener('change', () => runStep(step));
    return step;
  }
  const firstStep = chain.querySelector('.decoder-step');
  firstPick.addEventListener('change', () => runStep(firstStep));
  firstStep.querySelector('.decoder-input').addEventListener('input', () => {
    if (firstPick.value) runStep(firstStep);
  });
  $('#decoderClear').addEventListener('click', () => {
    firstStep.querySelector('.decoder-input').value = '';
    firstPick.value = '';
    pruneAfter(firstStep);
    const out = firstStep.querySelector('.decoder-output-wrap');
    if (out) out.remove();
    const add = firstStep.querySelector('.decoder-add');
    if (add) add.remove();
    delete firstStep.dataset.output;
  });
})();

// ============================== scope =============================
let scopeRules = [];
function renderScopeTable() {
  $('#scopeCount').textContent = scopeRules.filter((r) => r.enabled).length;
  $('#scopeBody').innerHTML = scopeRules
    .map(
      (r) =>
        `<tr data-id="${r.id}">` +
        `<td><input type="checkbox" class="scope-en" ${r.enabled ? 'checked' : ''} /></td>` +
        `<td class="${r.mode === 'exclude' ? 'sev-High' : 'm-POST'}">${r.mode}</td>` +
        `<td title="${esc(r.host)}">${esc(r.host)}</td>` +
        `<td class="muted">${r.port || ''}</td>` +
        `<td class="muted" title="${esc(r.pathPrefix || '')}">${esc(r.pathPrefix || '')}</td>` +
        `<td><button class="btn sm scope-del">Remove</button></td>` +
        `</tr>`
    )
    .join('');
}
$('#scopeAddBtn').addEventListener('click', async () => {
  const host = $('#scopeHost').value.trim();
  if (!host) { toast('Enter a host'); return; }
  const rule = {
    mode: $('#scopeMode').value,
    host,
    port: $('#scopePort').value ? Number($('#scopePort').value) : undefined,
    pathPrefix: $('#scopePath').value.trim() || undefined,
  };
  const res = await api.scopeAdd(rule);
  if (!res.ok) { toast('⚠ ' + ((res.rule && res.rule.error) || 'Invalid rule')); return; }
  scopeRules = res.rules;
  renderScopeTable();
  $('#scopeHost').value = $('#scopePort').value = $('#scopePath').value = '';
});
$('#scopeBody').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  if (e.target.classList.contains('scope-del')) {
    scopeRules = await api.scopeRemove(tr.dataset.id);
    renderScopeTable();
  }
});
$('#scopeBody').addEventListener('change', async (e) => {
  const tr = e.target.closest('tr');
  if (tr && e.target.classList.contains('scope-en')) {
    scopeRules = await api.scopeToggle(tr.dataset.id, e.target.checked);
    renderScopeTable();
  }
});
api.on('evt:scope-changed', (rules) => { scopeRules = rules; renderScopeTable(); });
$('#scopeOnly').addEventListener('change', (e) => { scopeOnly = e.target.checked; renderFlowTable(); });

// ============================ sequencer ===========================
(function initSequencer() {
  const g = (id) => document.getElementById(id);
  const startBtn = g('seq-start');
  const stopBtn = g('seq-stop');
  const label = g('seq-progress-label');
  const results = g('seq-results');
  const srcType = g('seq-src-type');
  const srcName = g('seq-src-name');
  const srcGroup = g('seq-src-group');
  if (!startBtn) return;
  let currentJob = null;
  srcType.addEventListener('change', () => {
    srcGroup.hidden = srcType.value !== 'regex';
    srcName.placeholder =
      srcType.value === 'regex' ? 'regex pattern'
      : srcType.value === 'json' ? 'json path (e.g. data.token)'
      : srcType.value === 'cookie' ? 'cookie name (e.g. SESSIONID)'
      : 'header name (e.g. X-Token)';
  });
  function parseRequest(raw) {
    const text = (raw || '').replace(/\r\n/g, '\n');
    const sep = text.indexOf('\n\n');
    const head = sep === -1 ? text : text.slice(0, sep);
    const body = sep === -1 ? '' : text.slice(sep + 2);
    const lines = head.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) return null;
    const [method, url] = lines[0].trim().split(/\s+/);
    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].indexOf(':');
      if (c === -1) continue;
      headers[lines[i].slice(0, c).trim()] = lines[i].slice(c + 1).trim();
    }
    return { method: method || 'GET', url, headers, body };
  }
  function buildTokenSource() {
    const name = srcName.value.trim();
    switch (srcType.value) {
      case 'header': return { type: 'header', name };
      case 'cookie': return { type: 'cookie', name };
      case 'json': return { type: 'json', path: name };
      case 'regex': return { type: 'regex', pattern: name, group: Number(srcGroup.value) || 0 };
      default: return null;
    }
  }
  function render(a) {
    if (!a) { results.textContent = 'No analysis.'; return; }
    const vClass = a.verdict === 'good' ? '#4caf7d' : a.verdict === 'moderate' ? '#d9a441' : '#e05a5a';
    const rows = (a.perPosition || [])
      .map((p) => `  pos ${String(p.position).padStart(3)}  entropy ${p.entropy.toFixed(3)} bits  distinct ${p.distinct}`)
      .join('\n');
    results.innerHTML =
      `<div style="font-weight:600;color:${vClass}">Verdict: ${String(a.verdict).toUpperCase()}</div>` +
      `<pre style="white-space:pre-wrap;margin-top:8px;font-family:var(--mono)">` +
      `tokens collected : ${a.tokens}  (requested ${a.requested}, errors ${a.errors})\n` +
      `unique / dupes   : ${a.unique} / ${a.duplicates}\n` +
      `length min/max/mean : ${a.lengths.min} / ${a.lengths.max} / ${a.lengths.mean}\n` +
      `analyzed length  : ${a.analyzedLength}\n` +
      `entropy / char   : ${a.overallEntropy} bits\n` +
      `estimated total  : ${a.estimatedBits} bits\n\n` +
      `per-position entropy:\n${rows}` +
      `</pre>`;
  }
  startBtn.addEventListener('click', async () => {
    const request = parseRequest(g('seq-request').value);
    if (!request || !request.url) { label.textContent = 'enter a valid request (METHOD URL)'; return; }
    currentJob = 'seq-' + Date.now();
    const count = parseInt(g('seq-count').value, 10) || 200;
    const concurrency = parseInt(g('seq-conc').value, 10) || 10;
    startBtn.disabled = true; stopBtn.disabled = false;
    label.textContent = 'starting...';
    results.textContent = 'collecting tokens...';
    try {
      await window.api.startSequencer({ jobId: currentJob, request, count, concurrency, tokenSource: buildTokenSource() });
    } catch (e) {
      label.textContent = 'error: ' + (e && e.message ? e.message : e);
      startBtn.disabled = false; stopBtn.disabled = true;
    }
  });
  stopBtn.addEventListener('click', () => {
    if (currentJob) window.api.stopSequencer(currentJob);
    stopBtn.disabled = true;
  });
  window.api.on('evt:seq-progress', (p) => {
    if (p.jobId !== currentJob) return;
    label.textContent = `collected ${p.collected} / ${p.total}`;
  });
  window.api.on('evt:seq-done', (p) => {
    if (p.jobId !== currentJob) return;
    label.textContent = `done — ${p.analysis.tokens} tokens`;
    startBtn.disabled = false; stopBtn.disabled = true;
    render(p.analysis);
  });
})();

// =========================== discovery ============================
let discJobId = null;
const discRows = [];
function renderDiscTable() {
  $('#discCount').textContent = discRows.length;
  $('#discBody').innerHTML = discRows
    .map(
      (r) =>
        `<tr><td class="${statusClass(r.status)}">${r.status}</td>` +
        `<td class="muted">${fmtLen(r.length)}</td>` +
        `<td title="${esc(r.path)}">${esc(r.path)}</td>` +
        `<td class="muted">${esc(r.mime || '')}</td></tr>`
    )
    .join('');
}
function setDiscRunning(on) {
  $('#discStartBtn').disabled = on;
  $('#discStopBtn').disabled = !on;
}
$('#discStartBtn').addEventListener('click', async () => {
  const baseUrl = $('#discBaseUrl').value.trim();
  if (!baseUrl) { toast('Enter a base URL'); return; }
  const extensions = $('#discExt').value.split(',').map((s) => s.trim()).filter((s, i, a) => s !== '' || a.indexOf('') === i);
  const wordlist = $('#discWordlist').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const concurrency = Number($('#discConc').value) || 15;
  discRows.length = 0;
  renderDiscTable();
  discJobId = `disc-${Date.now()}`;
  setDiscRunning(true);
  $('#discProgress').textContent = 'Scanning…';
  try {
    await api.startDiscovery({
      jobId: discJobId,
      baseUrl,
      wordlist: wordlist.length ? wordlist : null,
      extensions: extensions.length ? extensions : [''],
      concurrency,
    });
  } catch (e) {
    toast('Discovery error: ' + e.message);
    setDiscRunning(false);
  }
});
$('#discStopBtn').addEventListener('click', () => {
  if (discJobId) api.stopDiscovery(discJobId);
  $('#discProgress').textContent = 'Stopping…';
});
api.on('evt:disc-result', ({ jobId, row }) => {
  if (jobId !== discJobId) return;
  discRows.push(row);
  renderDiscTable();
});
api.on('evt:disc-progress', ({ jobId, done, total }) => {
  if (jobId !== discJobId) return;
  $('#discProgress').textContent = `Scanning… ${done}/${total} — ${discRows.length} hit(s)`;
});
api.on('evt:disc-done', ({ jobId, hits }) => {
  if (jobId !== discJobId) return;
  setDiscRunning(false);
  $('#discProgress').textContent = `Done — ${hits} hit(s).`;
});

// ========================= match & replace ========================
const mrRules = [];
let mrEditingId = null;
const MR_PART_LABEL = {
  'req-header': 'Req header', 'req-body': 'Req body', 'req-firstline': 'Req line',
  'res-header': 'Res header', 'res-body': 'Res body', 'res-status': 'Res status',
};
function renderMrTable() {
  $('#mrCount').textContent = mrRules.filter((r) => r.enabled).length;
  $('#mrBody').innerHTML = mrRules
    .map(
      (r) =>
        `<tr data-id="${r.id}" class="${r.id === mrEditingId ? 'selected' : ''}">` +
        `<td><input type="checkbox" class="mr-on" data-id="${r.id}" ${r.enabled ? 'checked' : ''}></td>` +
        `<td title="${esc(r.comment || '')}">${esc(r.name)}</td>` +
        `<td class="muted">${MR_PART_LABEL[r.part] || r.part}</td>` +
        `<td class="muted">${esc(r.matchType)}</td>` +
        `<td title="${esc(r.match)}">${esc(r.match)}</td>` +
        `<td title="${esc(r.replace)}">${esc(r.replace)}</td>` +
        `<td><button class="btn sm mr-del" data-id="${r.id}">✕</button></td>` +
        `</tr>`
    )
    .join('');
}
async function mrReload() {
  const rules = await api.mrList();
  mrRules.length = 0;
  rules.forEach((r) => mrRules.push(r));
  renderMrTable();
}
function mrLoadForm(rule) {
  mrEditingId = rule ? rule.id : null;
  $('#mrFormTitle').textContent = rule ? 'Edit rule' : 'New rule';
  $('#mrDeleteBtn').disabled = !rule;
  $('#mrName').value = rule ? rule.name : '';
  $('#mrPart').value = rule ? rule.part : 'req-header';
  $('#mrType').value = rule ? rule.matchType : 'string';
  $('#mrMatch').value = rule ? rule.match : '';
  $('#mrReplace').value = rule ? rule.replace : '';
  $('#mrComment').value = rule ? rule.comment : '';
  $('#mrEnabled').checked = rule ? rule.enabled : true;
  renderMrTable();
}
function mrFormValues() {
  return {
    name: $('#mrName').value.trim() || 'Rule',
    part: $('#mrPart').value,
    matchType: $('#mrType').value,
    match: $('#mrMatch').value,
    replace: $('#mrReplace').value,
    comment: $('#mrComment').value,
    enabled: $('#mrEnabled').checked,
  };
}
$('#mrNewBtn').addEventListener('click', () => mrLoadForm(null));
$('#mrCancelBtn').addEventListener('click', () => mrLoadForm(null));
$('#mrSaveBtn').addEventListener('click', async () => {
  const vals = mrFormValues();
  if (mrEditingId) await api.mrUpdate(mrEditingId, vals);
  else {
    const created = await api.mrAdd(vals);
    mrEditingId = created && created.id;
  }
  await mrReload();
  mrLoadForm(mrRules.find((x) => x.id === mrEditingId) || null);
  toast('Rule saved');
});
$('#mrDeleteBtn').addEventListener('click', async () => {
  if (!mrEditingId) return;
  await api.mrRemove(mrEditingId);
  mrEditingId = null;
  await mrReload();
  mrLoadForm(null);
  toast('Rule deleted');
});
$('#mrBody').addEventListener('click', async (e) => {
  const del = e.target.closest('.mr-del');
  if (del) {
    e.stopPropagation();
    await api.mrRemove(del.dataset.id);
    if (mrEditingId === del.dataset.id) mrEditingId = null;
    await mrReload();
    if (!mrEditingId) mrLoadForm(null);
    return;
  }
  if (e.target.classList.contains('mr-on')) return;
  const tr = e.target.closest('tr');
  if (!tr) return;
  const rule = mrRules.find((x) => x.id === tr.dataset.id);
  if (rule) mrLoadForm(rule);
});
$('#mrBody').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('mr-on')) return;
  await api.mrToggle(e.target.dataset.id, e.target.checked);
  await mrReload();
});

// ============================ exporter ============================
$('#exportJsonBtn').addEventListener('click', async () => {
  const res = await api.exportJson();
  if (res.ok) toast('Exported ' + res.count + ' flows to JSON');
  else if (!res.canceled) toast('⚠ Export failed' + (res.error ? ': ' + res.error : ''));
});
$('#exportHarBtn').addEventListener('click', async () => {
  const res = await api.exportHar();
  if (res.ok) toast('Exported ' + res.count + ' flows to HAR');
  else if (!res.canceled) toast('⚠ Export failed' + (res.error ? ': ' + res.error : ''));
});
$('#importJsonBtn').addEventListener('click', async () => {
  const res = await api.importJson();
  if (res.ok) toast('Imported ' + res.count + ' flows');
  else if (!res.canceled) toast('⚠ Import failed' + (res.error ? ': ' + res.error : ''));
});

// ========================== collaborator ==========================
const collabRows = new Map();
let collabSelected = null;
function collabApplyStatus(s) {
  s = s || {};
  const txt = $('#collabStatusText');
  $('#collabStartBtn').disabled = s.running || s.starting || !s.cloudflared;
  $('#collabStopBtn').disabled = !s.running && !s.starting;
  $('#collabGenBtn').disabled = !s.running;
  if (!s.cloudflared) txt.textContent = 'cloudflared not found — run: brew install cloudflared';
  else if (s.starting) txt.textContent = 'Starting tunnel…';
  else if (s.running) txt.textContent = 'Tunnel live';
  else txt.textContent = 'Stopped';
  $('#collabUrl').textContent = s.publicUrl || '';
}
$('#collabStartBtn').addEventListener('click', async () => {
  $('#collabStatusText').textContent = 'Starting tunnel…';
  const s = await api.collabStart();
  if (s && s.error) toast('⚠ ' + s.error);
  collabApplyStatus(s);
});
$('#collabStopBtn').addEventListener('click', async () => {
  collabApplyStatus(await api.collabStop());
});
$('#collabGenBtn').addEventListener('click', async () => {
  const p = await api.collabGenerate();
  if (p.error) { toast('⚠ ' + p.error); return; }
  try { await navigator.clipboard.writeText(p.httpUrl); } catch (_) {}
  toast('Payload copied: ' + p.httpUrl);
});
function renderCollabTable() {
  $('#collabCount').textContent = collabRows.size;
  const rows = [...collabRows.values()].sort((a, b) => b.id - a.id);
  $('#collabBody').innerHTML = rows
    .map(
      (r) =>
        `<tr data-id="${r.id}" class="${r.id === collabSelected ? 'selected' : ''}">` +
        `<td class="muted">${r.id}</td>` +
        `<td class="method m-${r.method}">${esc(r.method)}</td>` +
        `<td title="${esc(r.url)}">${esc(r.url)}</td>` +
        `<td class="muted">${esc(r.payload || '')}</td>` +
        `<td class="muted">${esc(r.remote || '')}</td>` +
        `<td class="muted">${new Date(r.ts).toLocaleTimeString()}</td>` +
        `</tr>`
    )
    .join('');
}
$('#collabBody').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  collabSelected = Number(tr.dataset.id);
  renderCollabTable();
  const rec = await api.collabGet(collabSelected);
  if (!rec) return;
  $('#collabDetailMeta').textContent = `${rec.method} ${rec.url} · ${rec.payload || 'no payload match'}`;
  const headers = Object.entries(rec.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  $('#collabRaw').textContent =
    `${rec.method} ${rec.url} HTTP/${rec.httpVersion}\nFrom: ${rec.remote}\n\n${headers}\n\n${rec.body || ''}`;
});
api.on('evt:collab-interaction', (rec) => {
  collabRows.set(rec.id, rec);
  renderCollabTable();
});
api.on('evt:collab-status', (s) => collabApplyStatus(s));

// ========================= keyboard shortcuts =====================
// Burp-style, data-driven and user-remappable (Settings → Keyboard shortcuts).
// 'mod' matches ⌘ on macOS / Ctrl elsewhere.
const IS_MAC = (navigator.platform || '').toLowerCase().includes('mac');

function activeViewName() {
  const v = $('.view.active');
  return v ? v.id.replace('view-', '') : '';
}
function runActiveTab() {
  const view = activeViewName();
  if (view === 'repeater') $('#repSendBtn').click();
  else if (view === 'intruder') $('#intrStartBtn').click();
  else if (view === 'sequencer') document.getElementById('seq-start').click();
  else if (view === 'discovery') $('#discStartBtn').click();
}
async function transformSelection(transformId) {
  const el = document.activeElement;
  if (!el || !(el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) return false;
  const start = el.selectionStart, end = el.selectionEnd;
  if (start == null || start === end) return false;
  const sel = el.value.slice(start, end);
  try {
    let out = await window.Transforms.apply(transformId, sel);
    // Smart-decode annotates with a leading "// …" line; drop it for inline edits.
    if (transformId === 'smart') out = out.replace(/^\/\/[^\n]*\n/, '');
    el.value = el.value.slice(0, start) + out + el.value.slice(end);
    el.selectionStart = start;
    el.selectionEnd = start + out.length;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } catch (e) {
    toast('⚠ ' + e.message);
  }
  return true;
}

// action id -> { label, run? , transform? }
const ACTIONS = {
  'send-repeater': { label: 'Send selected request to Repeater', run: () => currentFlow ? sendFlowToRepeater(currentFlow) : toast('Select a request first') },
  'send-intruder': { label: 'Send selected request to Intruder', run: () => currentFlow ? sendFlowToIntruder(currentFlow) : toast('Select a request first') },
  'goto-repeater': { label: 'Go to Repeater tab', run: () => showView('repeater') },
  'goto-intruder': { label: 'Go to Intruder tab', run: () => showView('intruder') },
  'send-run': { label: 'Send / run current tab', run: runActiveTab },
  'send-comparer': { label: 'Send response to Comparer', run: () => (currentFlow && currentFlow.response) ? window.sendToComparer(buildResponseRaw(currentFlow), 'a') : toast('Select a request with a response') },
  'b64-encode': { label: 'Base64 encode selection', transform: 'b64enc' },
  'b64-decode': { label: 'Base64 decode selection', transform: 'b64dec' },
  'url-encode': { label: 'URL encode selection', transform: 'urlenc' },
  'url-decode': { label: 'URL decode selection', transform: 'urldec' },
  'html-encode': { label: 'HTML encode selection', transform: 'htmlenc' },
  'html-decode': { label: 'HTML decode selection', transform: 'htmldec' },
  'smart-decode': { label: 'Smart-decode selection', transform: 'smart' },
  'help': { label: 'Show shortcuts list', run: () => toggleShortcutHelp() },
};
const DEFAULT_KEYMAP = {
  'send-repeater': 'mod+r',
  'send-intruder': 'mod+i',
  'goto-repeater': 'mod+shift+r',
  'goto-intruder': 'mod+shift+i',
  'send-run': 'mod+enter',
  'send-comparer': 'mod+shift+c',
  'b64-encode': 'mod+b',
  'b64-decode': 'mod+shift+b',
  'url-encode': 'mod+u',
  'url-decode': 'mod+shift+u',
  'html-encode': 'mod+h',
  'html-decode': 'mod+shift+h',
  'smart-decode': 'mod+shift+d',
  'help': 'mod+/',
};
let keymap = { ...DEFAULT_KEYMAP };

function comboFromEvent(e) {
  const k = (e.key || '').toLowerCase();
  if (['meta', 'control', 'shift', 'alt'].includes(k)) return null; // lone modifier
  const parts = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(k === ' ' ? 'space' : k);
  return parts.join('+');
}
function comboLabel(combo) {
  if (!combo) return '—';
  return combo.split('+').map((p) => {
    if (p === 'mod') return IS_MAC ? '⌘' : 'Ctrl';
    if (p === 'shift') return IS_MAC ? '⇧' : 'Shift';
    if (p === 'alt') return IS_MAC ? '⌥' : 'Alt';
    if (p === 'enter') return '↵';
    return p.length === 1 ? p.toUpperCase() : p;
  }).join(IS_MAC ? '' : '+');
}

function toggleShortcutHelp(force) {
  const el = $('#shortcutHelp');
  const show = force != null ? force : el.classList.contains('hidden');
  if (show) {
    $('#shortcutList').innerHTML = Object.keys(ACTIONS)
      .map((id) => `<div class="sc-row"><kbd>${esc(comboLabel(keymap[id]))}</kbd><span>${esc(ACTIONS[id].label)}</span></div>`)
      .join('');
  }
  el.classList.toggle('hidden', !show);
}
$('#shortcutClose').addEventListener('click', () => toggleShortcutHelp(false));
$('#shortcutHelp').addEventListener('click', (e) => {
  if (e.target.id === 'shortcutHelp') toggleShortcutHelp(false);
});

// ---- remapping (Settings → Keyboard shortcuts) ----
let recordingAction = null;
function renderShortcutSettings() {
  const wrap = $('#shortcutSettings');
  if (!wrap) return;
  wrap.innerHTML = Object.keys(ACTIONS)
    .map(
      (id) =>
        `<div class="sc-set-row">` +
        `<span>${esc(ACTIONS[id].label)}</span>` +
        `<kbd>${esc(comboLabel(keymap[id]))}</kbd>` +
        `<button class="btn sm sc-rec" data-act="${id}">${recordingAction === id ? 'press keys…' : 'Change'}</button>` +
        `</div>`
    )
    .join('');
}
function assignShortcut(id, combo) {
  // Clear the same combo from any other action to avoid duplicates.
  for (const other of Object.keys(keymap)) {
    if (other !== id && keymap[other] === combo) keymap[other] = '';
  }
  keymap[id] = combo;
  api.setSettings({ shortcuts: keymap });
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.sc-rec');
  if (!b) return;
  recordingAction = recordingAction === b.dataset.act ? null : b.dataset.act;
  renderShortcutSettings();
});
$('#shortcutResetBtn') && $('#shortcutResetBtn').addEventListener('click', () => {
  keymap = { ...DEFAULT_KEYMAP };
  api.setSettings({ shortcuts: keymap });
  renderShortcutSettings();
  toast('Shortcuts reset to defaults');
});

window.addEventListener('keydown', async (e) => {
  if (e.key === 'Escape') { toggleShortcutHelp(false); if (recordingAction) { recordingAction = null; renderShortcutSettings(); } return; }
  const combo = comboFromEvent(e);
  if (!combo) return;

  // Remap capture mode: require the primary modifier so single keys aren't stolen.
  if (recordingAction) {
    if (!(e.metaKey || e.ctrlKey || e.altKey)) return;
    e.preventDefault();
    assignShortcut(recordingAction, combo);
    recordingAction = null;
    renderShortcutSettings();
    toast('Shortcut set: ' + comboLabel(combo));
    return;
  }

  if (!(e.metaKey || e.ctrlKey)) return;
  const id = Object.keys(keymap).find((a) => keymap[a] && keymap[a] === combo);
  if (!id) return;
  const a = ACTIONS[id];
  if (a.transform) {
    if (await transformSelection(a.transform)) e.preventDefault();
    return;
  }
  e.preventDefault();
  a.run();
});

// ============================= init ===============================
(async function init() {
  const state = await api.proxyStatus();
  applyStatus(state);
  const caPath = await api.caPath();
  $('#caPathText').textContent = caPath;
  const settings = await api.getSettings();
  $('#setPort').value = settings.port || 8080;

  // Fetch the live model list from the CLI's login (Anthropic Models API);
  // fall back to the static lineup if unavailable.
  try {
    const live = await api.listModels();
    if (Array.isArray(live) && live.length) {
      modelList = [{ id: '', label: 'Default (account)' }].concat(live);
    }
  } catch (_) {
    /* keep FALLBACK_MODELS */
  }
  populateModelSelect($('#chatModel'), settings.chatModel != null ? settings.chatModel : '');
  populateModelSelect($('#setModel'), settings.model != null ? settings.model : 'claude-sonnet-5-5');
  $('#chatModel').addEventListener('change', (e) => api.setSettings({ chatModel: e.target.value }));

  // Load any remapped shortcuts and render the Settings editor.
  keymap = { ...DEFAULT_KEYMAP, ...(settings.shortcuts || {}) };
  renderShortcutSettings();

  // Populate the testing-browser picker with whatever is installed.
  const browsers = await api.listBrowsers();
  const sel = $('#setBrowser');
  browsers.forEach((b) => {
    const opt = document.createElement('option');
    opt.value = b.path;
    opt.textContent = b.name;
    sel.appendChild(opt);
  });
  if (settings.browser) sel.value = settings.browser;
  if (!browsers.length) {
    $('#openBrowserBtn').title = 'No Chromium-family browser found';
  }
  sel.addEventListener('change', (e) => api.setSettings({ browser: e.target.value }));
  newRepeaterTab();
  refreshInterceptView();
  recheckAuth();

  // Feature startup loads.
  scopeRules = await api.scopeList();
  renderScopeTable();
  await mrReload();
  mrLoadForm(null);
  collabApplyStatus(await api.collabStatus());
  const prevInteractions = await api.collabList();
  prevInteractions.forEach((r) => collabRows.set(r.id, r));
  renderCollabTable();

  // Build tab: show the agent's workspace path.
  const ws = await api.assistantWorkspace();
  $('#chatWorkspace').textContent = 'workspace: ' + ws;
  await chatLoadList();
  await refreshMobile();
})();
})(); // end app IIFE
