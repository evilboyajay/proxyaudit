'use strict';
/*
 * Headless renderer QA harness.
 * Loads the real index.html + app.js in jsdom with a mocked window.api,
 * then drives every tab and event path, asserting the UI reacts. Catches
 * interaction-time exceptions that a static review can miss.
 *
 *   node test/renderer-qa.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..', 'src', 'renderer');
const results = [];
const errors = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: cond ? '' : detail || '' });
}

// ---- mocked main-process API ----
const calls = {};
function rec(n, ret) {
  calls[n] = calls[n] || [];
  return (...args) => {
    calls[n].push(args);
    return typeof ret === 'function' ? ret(...args) : Promise.resolve(ret);
  };
}
const handlers = {};
// Minimal stateful chat store mock (for multi-chat concurrency tests).
let chatSeq = 0;
const chatDb = {
  chats: new Map(),
  create(title) {
    const id = 'c' + (++chatSeq);
    const r = { id, title: title || '', sessionId: null, messages: [], titled: !!title };
    this.chats.set(id, r);
    return { ...r };
  },
  get(id) { const r = this.chats.get(id); return r ? JSON.parse(JSON.stringify(r)) : null; },
  append(id, msg) {
    let r = this.chats.get(id);
    if (!r) r = this.chats.get(this.create().id);
    r.messages.push({ role: msg.role, content: String(msg.content || ''), meta: msg.meta });
    if (!r.titled && msg.role === 'user') { r.title = String(msg.content).slice(0, 40); r.titled = true; }
    return true;
  },
  setSession(id, s) { const r = this.chats.get(id); if (r) r.sessionId = s; return true; },
  rename(id, t) { const r = this.chats.get(id); if (r) { r.title = t; r.titled = true; } return true; },
  del(id) { this.chats.delete(id); return true; },
  list() {
    return Array.from(this.chats.values())
      .map((r) => ({ id: r.id, title: r.title || 'New chat', updatedAt: 0, messageCount: r.messages.length }))
      .reverse();
  },
};
const api = {
  startProxy: rec('startProxy', { running: true, port: 8080, intercept: false, caPath: '/x/ca.pem' }),
  stopProxy: rec('stopProxy', { running: false, port: 8080 }),
  proxyStatus: rec('proxyStatus', { running: false, port: 8080, intercept: false, caPath: '/x/ca.pem' }),
  setIntercept: rec('setIntercept', { running: true, port: 8080, intercept: true, caPath: '/x/ca.pem' }),
  resolveIntercept: rec('resolveIntercept', true),
  listFlows: rec('listFlows', []),
  getFlow: rec('getFlow', {
    id: 'f1', method: 'GET', scheme: 'https', host: 'ex.com', path: '/a',
    url: 'https://ex.com/a', httpVersion: '1.1',
    request: { headers: { host: 'ex.com', accept: '*/*' }, body: '' },
    response: { status: 200, statusMessage: 'OK', headers: { 'content-type': 'text/html' }, body: '<html>ok</html>', mime: 'text/html', length: 15 },
  }),
  clearFlows: rec('clearFlows', true),
  listWs: rec('listWs', []),
  getWs: rec('getWs', { id: 'w1', url: 'wss://ex.com/s', host: 'ex.com', closed: false,
    messages: [{ ts: Date.now(), direction: 'outgoing', binary: false, length: 5, data: 'hello' }] }),
  sendRequest: rec('sendRequest', { status: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, body: '{"ok":true}', length: 11, durationMs: 42, mime: 'application/json' }),
  // Intruder
  intruderCount: rec('intruderCount', { positions: 1, total: 3 }),
  intruderStart: rec('intruderStart', { attackId: 'atk1', total: 3, positions: 1, attackType: 'sniper' }),
  intruderStop: rec('intruderStop', true),
  intruderResult: rec('intruderResult', { request: { method: 'GET', url: 'https://ex.com/a', headers: {}, body: '' }, response: { status: 200, statusMessage: 'OK', headers: {}, body: 'x', length: 1, durationMs: 5 } }),
  // Sequencer
  startSequencer: rec('startSequencer', { jobId: 'seq1' }),
  stopSequencer: rec('stopSequencer', true),
  getSeqTokens: rec('getSeqTokens', []),
  // Discovery
  startDiscovery: rec('startDiscovery', { jobId: 'disc1' }),
  stopDiscovery: rec('stopDiscovery', true),
  discoveryResults: rec('discoveryResults', []),
  // Scope
  scopeList: rec('scopeList', [{ id: 's1', enabled: true, mode: 'include', host: 'ex.com' }]),
  scopeAdd: rec('scopeAdd', { ok: true, rule: { id: 's2' }, rules: [{ id: 's1', enabled: true, mode: 'include', host: 'ex.com' }, { id: 's2', enabled: true, mode: 'exclude', host: 'evil.com' }] }),
  scopeRemove: rec('scopeRemove', []),
  scopeToggle: rec('scopeToggle', [{ id: 's1', enabled: false, mode: 'include', host: 'ex.com' }]),
  scopeCheck: rec('scopeCheck', true),
  // Match & Replace
  mrList: rec('mrList', [{ id: 'm1', enabled: true, name: 'Redact', part: 'req-body', matchType: 'regex', match: 'pw=.*', replace: 'pw=X', comment: '' }]),
  mrAdd: rec('mrAdd', { id: 'm2', enabled: true, name: 'Rule', part: 'req-header', matchType: 'string', match: 'a', replace: 'b', comment: '' }),
  mrUpdate: rec('mrUpdate', true),
  mrRemove: rec('mrRemove', true),
  mrToggle: rec('mrToggle', true),
  // Collaborator
  collabStatus: rec('collabStatus', { running: false, starting: false, cloudflared: true, publicUrl: null, port: null, interactions: 0 }),
  collabStart: rec('collabStart', { running: true, starting: false, cloudflared: true, publicUrl: 'https://abc.trycloudflare.com', port: 5000, interactions: 0 }),
  collabStop: rec('collabStop', { running: false, starting: false, cloudflared: true, publicUrl: null }),
  collabGenerate: rec('collabGenerate', { id: 'ab12cd34ef', httpUrl: 'https://abc.trycloudflare.com/ab12cd34ef', host: 'abc.trycloudflare.com' }),
  collabList: rec('collabList', []),
  collabGet: rec('collabGet', { id: 1, method: 'GET', url: '/ab12cd34ef', httpVersion: '1.1', headers: { host: 'abc.trycloudflare.com' }, body: '', remote: '1.2.3.4', payload: 'ab12cd34ef' }),
  // Export / import
  exportJson: rec('exportJson', { ok: true, count: 3 }),
  exportHar: rec('exportHar', { ok: true, count: 3 }),
  importJson: rec('importJson', { ok: true, count: 2 }),
  listBrowsers: rec('listBrowsers', [{ id: 'chrome', name: 'Google Chrome', path: '/x/chrome' }]),
  openBrowser: rec('openBrowser', { ok: true, browser: 'Google Chrome' }),
  caPath: rec('caPath', '/x/ca.pem'),
  revealCa: rec('revealCa', true),
  getSettings: rec('getSettings', { port: 8080, model: 'sonnet', browser: '' }),
  setSettings: rec('setSettings', { port: 8080, model: 'opus', browser: '' }),
  checkAuth: rec('checkAuth', { authenticated: true }),
  authStatus: rec('authStatus', { loggedIn: true, email: 'user@example.com', subscriptionType: 'max', authMethod: 'claude.ai' }),
  authLogin: rec('authLogin', { ok: true }),
  authLogout: rec('authLogout', { ok: true }),
  auditEndpoint: rec('auditEndpoint', { report: 'ok' }),
  auditJs: rec('auditJs', { report: 'ok' }),
  auditAllJs: rec('auditAllJs', { files: 0 }),
  // Build / plugins
  pluginsList: rec('pluginsList', [{ name: 'Security headers', enabled: true, error: null, description: '' }]),
  pluginRead: rec('pluginRead', 'register({ name: "Security headers", onResponse(f, a) {} });'),
  pluginSave: rec('pluginSave', { ok: true, name: 'My Plugin' }),
  pluginDelete: rec('pluginDelete', true),
  pluginToggle: rec('pluginToggle', true),
  pluginTemplate: rec('pluginTemplate', 'register({ name: "Security headers", onResponse(flow, api) {} });'),
  pluginRun: rec('pluginRun', { ok: true, name: 'Security headers' }),
  pluginFindings: rec('pluginFindings', []),
  pluginClearFindings: rec('pluginClearFindings', true),
  // Build: Claude agent
  assistantSend: rec('assistantSend', { sessionId: 'sess-1' }),
  assistantStop: rec('assistantStop', true),
  assistantWorkspace: rec('assistantWorkspace', '/Users/x/.proxyaudit/workspace'),
  listModels: rec('listModels', [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }, { id: 'sonnet', label: 'sonnet' }]),
  // Build: chat history — a small stateful store so multi-chat behaviour
  // (background runs persisting to the right conversation) can be tested.
  chatsList: rec('chatsList', () => chatDb.list()),
  chatCreate: rec('chatCreate', (title) => chatDb.create(title)),
  chatGet: rec('chatGet', (id) => chatDb.get(id)),
  chatRename: rec('chatRename', (id, title) => chatDb.rename(id, title)),
  chatDelete: rec('chatDelete', (id) => chatDb.del(id)),
  chatsClear: rec('chatsClear', () => { chatDb.chats.clear(); return true; }),
  chatAppend: rec('chatAppend', (id, message) => chatDb.append(id, message)),
  chatSetSession: rec('chatSetSession', (id, sessionId) => chatDb.setSession(id, sessionId)),
  on: (channel, handler) => { (handlers[channel] = handlers[channel] || []).push(handler); return () => {}; },
};
function fire(channel, payload) { (handlers[channel] || []).forEach((h) => h(payload)); }

// ---- build DOM ----
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .replace('<script src="app.js"></script>', '');
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.detail || e.message)));
const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const { window } = dom;
window.api = api;
window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
window.addEventListener('error', (e) => errors.push('window.error: ' + (e.error ? e.error.stack : e.message)));
window.onerror = (m, s, l, c, err) => { errors.push('onerror: ' + (err ? err.stack : m)); };
try {
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: () => Promise.resolve() }, configurable: true,
  });
} catch (_) { /* ignore */ }

// Load the helper scripts (transforms/diff/sitemap) exactly as index.html does.
for (const dep of ['transforms.js', 'diff.js', 'sitemap.js', 'msgview.js', 'targetview.js', 'httpfilter.js', 'ctxmenu.js']) {
  try {
    window.eval(fs.readFileSync(path.join(ROOT, dep), 'utf8'));
  } catch (e) {
    errors.push(`${dep} eval threw: ` + e.stack);
  }
}
const appjs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const $ = (sel) => window.document.querySelector(sel);

function click(el) {
  if (!el) return false;
  el.dispatchEvent(new window.Event('click', { bubbles: true }));
  return true;
}
function setVal(el, v) {
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// Two-level nav: click the view's top group then its sub-tab (if any).
function goto(view) {
  const sub = window.document.querySelector(`#subtabbar .subnav[data-view="${view}"]`);
  const group = sub ? sub.closest('.subnav-group').dataset.group : view;
  const gbtn = Array.from(window.document.querySelectorAll('#tabbar .nav')).find((n) => n.dataset.group === group);
  if (gbtn) click(gbtn);
  if (sub) click(sub);
}

(async () => {
  // Guard against the contextBridge collision class: a bare global-scope
  // `const api = window.api` is a SyntaxError in a real <script> (window.api is
  // a non-configurable global), which jsdom's eval scope cannot reproduce.
  // Requiring the body to be IIFE-wrapped prevents any global-lexical top-level
  // declaration from regressing.
  {
    const iife = appjs.indexOf('(function () {');
    const apiDecl = appjs.indexOf('const api = window.api');
    check('app.js body is IIFE-wrapped (no global-lexical `const api`)',
      iife !== -1 && apiDecl !== -1 && iife < apiDecl,
      'app.js must wrap its body in an IIFE so top-level const/let are function-scoped');
  }
  try {
    window.eval(appjs);
  } catch (e) {
    errors.push('eval threw: ' + e.stack);
  }
  await wait(30); // let init() resolve

  // 1) Navigation: each nav switches to its view
  const views = ['proxy', 'sitemap', 'intercept', 'repeater', 'intruder', 'sequencer',
    'decoder', 'comparer', 'discovery', 'scope', 'matchreplace', 'websockets',
    'collaborator', 'build', 'settings'];
  for (const v of views) {
    goto(v);
    await wait(2);
    const section = $('#view-' + v);
    check('nav → ' + v + ' activates view', section && section.classList.contains('active'),
      'view-' + v + ' not active after clicking nav');
  }

  // 2) Settings populated from getSettings + listBrowsers
  check('settings: port populated', $('#setPort').value === '8080', 'port=' + $('#setPort').value);
  check('settings: model populated', $('#setModel').value === 'sonnet', 'model=' + $('#setModel').value);
  check('settings: browser option added', $('#setBrowser').options.length >= 2, 'opts=' + $('#setBrowser').options.length);
  setVal($('#setModel'), 'opus');
  await wait(2);
  check('settings: changing model calls setSettings', calls.setSettings.length, 'setSettings not called');

  // 3) Repeater send
  goto('repeater');
  check('repeater: initial tab exists', window.document.querySelectorAll('#repeaterTabs .tab').length >= 1, 'no repeater tab');
  setVal($('#repUrl'), 'https://ex.com/api');
  click($('#repSendBtn'));
  await wait(20);
  check('repeater: send calls api.sendRequest', calls.sendRequest.length, 'sendRequest not called');
  check('repeater: response rendered', /HTTP 200/.test($('#repResponse').textContent), 'resp=' + $('#repResponse').textContent.slice(0, 40));

  // 4) Open browser button
  click($('#openBrowserBtn'));
  await wait(10);
  check('browser: openBrowser called', calls.openBrowser.length, 'openBrowser not called');

  // 5) Flow event → table row
  fire('evt:status', { running: true, port: 8080, intercept: false, caPath: '/x/ca.pem' });
  fire('evt:flow', { id: 'f1', method: 'GET', scheme: 'https', host: 'ex.com', path: '/a', url: 'https://ex.com/a', status: null, mime: '', length: 0 });
  fire('evt:flow-update', { id: 'f1', method: 'GET', scheme: 'https', host: 'ex.com', path: '/a', url: 'https://ex.com/a', status: 200, mime: 'text/html', length: 15 });
  await wait(10);
  check('proxy: flow row rendered', window.document.querySelectorAll('#flowBody tr').length >= 1, 'no flow rows');
  check('proxy: flow count updated', $('#flowCount').textContent === '1', 'count=' + $('#flowCount').textContent);

  // 6) Select flow → detail
  click(window.document.querySelector('#flowBody tr'));
  await wait(10);
  check('proxy: request detail shown (MsgView)', /GET \/a/.test($('#reqView').textContent), 'req=' + $('#reqView').textContent.slice(0, 40));
  check('proxy: → Comparer btn enabled (has response)', !$('#toComparerBtn').disabled, 'toComparer disabled');

  // 7) Send to repeater from detail
  click($('#toRepeaterBtn'));
  await wait(5);
  check('proxy: → repeater adds tab', window.document.querySelectorAll('#repeaterTabs .tab').length >= 2, 'tabs=' + window.document.querySelectorAll('#repeaterTabs .tab').length);

  // Sortable headers + arrow-key navigation
  goto('proxy');
  ['zPOST', 'aGET', 'mPUT'].forEach((tag, i) =>
    fire('evt:flow-update', { id: 'sf' + i, method: tag.slice(1), scheme: 'https', host: tag[0] + '.com', path: '/' + i, url: 'https://' + tag[0] + '.com/' + i, status: 200 + i, mime: 'text/html', length: 100 * (3 - i) })
  );
  await wait(10);
  const methodTh = Array.from(window.document.querySelectorAll('#flowTable thead th')).find((t) => t.dataset.key === 'method');
  click(methodTh);
  await wait(5);
  const firstMethod = window.document.querySelector('#flowBody tr .method') && window.document.querySelector('#flowBody tr .method').textContent;
  check('proxy: header click sorts (by method asc)', firstMethod === 'GET', 'first=' + firstMethod);
  check('proxy: sorted header shows indicator', /▲/.test(methodTh.textContent), 'no arrow: ' + methodTh.textContent);
  // arrow-down from a selected row moves selection to the next row
  const firstRow = window.document.querySelector('#flowBody tr');
  firstRow.click();
  await wait(5);
  const beforeSel = window.document.querySelector('#flowBody tr.selected');
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await wait(5);
  const afterSel = window.document.querySelector('#flowBody tr.selected');
  check('proxy: ArrowDown moves selection to next item', afterSel && beforeSel && afterSel !== beforeSel, 'selection did not move');

  // Right-click "Send to AI"
  const rowForMenu = window.document.querySelector('#flowBody tr');
  rowForMenu.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
  await wait(10);
  const ctxMenu = window.document.querySelector('.ctx-menu');
  check('ctxmenu: Send to AI item present + highlighted', !!ctxMenu && /Send to AI/.test(ctxMenu.textContent) && !!ctxMenu.querySelector('.ctx-item.ctx-ai'), 'no AI item');
  const aiItem = ctxMenu && Array.from(ctxMenu.querySelectorAll('.ctx-item.ctx-ai')).find((x) => /new chat/.test(x.textContent));
  const sendsBeforeAI = calls.assistantSend.length;
  if (aiItem) aiItem.click();
  await wait(90);
  check('ctxmenu: Send to AI (new chat) opens Build + sends', $('#view-build').classList.contains('active') && calls.assistantSend.length > sendsBeforeAI, 'AI send did not fire');
  check('ctxmenu: Send to AI payload is a curl command', /curl /.test(calls.assistantSend[calls.assistantSend.length - 1][0].message || ''), 'no curl in AI message');
  // complete the AI turn so it doesn't block the next Build test
  const aiTurn = calls.assistantSend[calls.assistantSend.length - 1][0].turnId;
  fire('evt:assistant-event', { turnId: aiTurn, event: { type: 'done', sessionId: 'sess-1' } });
  await wait(5);

  // 8-9) Build tab: Claude agent chat
  goto('build');
  check('build: workspace shown on init', /workspace:/.test($('#chatWorkspace').textContent), 'no workspace');
  check('build: chat history loaded on init', calls.chatsList.length >= 1, 'chatsList not called');
  setVal($('#chatInput'), 'Audit every request for auth issues');
  click($('#chatSendBtn'));
  await wait(30);
  check('build: send persists + calls assistantSend', calls.assistantSend.length >= 1 && calls.chatCreate.length >= 1, 'assistantSend/chatCreate not called');
  check('build: user message rendered', /Audit every request/.test($('#chatMessages').textContent), 'no user bubble');
  const turn = calls.assistantSend[calls.assistantSend.length - 1][0].turnId;
  check('build: send is busy (stop enabled)', !$('#chatStopBtn').disabled, 'stop not enabled');
  check('build: Send button becomes Stop while running', $('#chatSendBtn').textContent === 'Stop', 'send label=' + $('#chatSendBtn').textContent);
  fire('evt:assistant-event', { turnId: turn, event: { type: 'tool_use', name: 'mcp__proxy__list_flows', input: {} } });
  await wait(5);
  check('build: tool-use card rendered', /list_flows/.test($('#chatMessages').textContent), 'no tool card');
  fire('evt:assistant-event', { turnId: turn, event: { type: 'text', text: 'Found **2 flows**. The login POST looks interesting.' } });
  await wait(5);
  check('build: assistant text rendered', /login POST looks interesting/.test($('#chatMessages').textContent), 'no assistant text');
  fire('evt:assistant-event', { turnId: turn, event: { type: 'done', sessionId: 'sess-1' } });
  await wait(5);
  check('build: done re-enables send', !$('#chatSendBtn').disabled && $('#chatStopBtn').disabled, 'still busy after done');
  check('build: shows done status line', !!window.document.querySelector('.chat-msg.status.done') && /·\s*done/.test($('#chatMessages').textContent), 'no done status');
  click($('#chatNewBtn'));
  check('build: new chat resets messages', /New chat/.test($('#chatMessages').textContent), 'not reset');

  // Slash commands + autonomous goal
  setVal($('#chatInput'), '/help');
  click($('#chatSendBtn'));
  await wait(5);
  check('build: /help shows commands', /Commands/.test($('#chatMessages').textContent), 'no help');
  setVal($('#chatInput'), '/agent on');
  click($('#chatSendBtn'));
  await wait(5);
  check('build: /agent on toggles Agent mode', $('#chatAgentMode').checked === true, 'agent not on');
  const sendsBefore = calls.assistantSend.length;
  setVal($('#chatInput'), '/goal find all IDOR issues');
  click($('#chatSendBtn'));
  await wait(30);
  check('build: /goal shows goal bar', !$('#chatGoalBar').classList.contains('hidden'), 'goal bar hidden');
  check('build: /goal starts a turn (agent mode)', calls.assistantSend.length > sendsBefore && $('#chatAgentMode').checked, 'goal did not start');
  const gturn = calls.assistantSend[calls.assistantSend.length - 1][0].turnId;
  fire('evt:assistant-event', { turnId: gturn, event: { type: 'text', text: 'Done.\nGOAL COMPLETE' } });
  fire('evt:assistant-event', { turnId: gturn, event: { type: 'done', sessionId: 'sess-1' } });
  await wait(10);
  check('build: GOAL COMPLETE clears the goal', $('#chatGoalBar').classList.contains('hidden'), 'goal still active');
  // Todo rendering
  const tturn = calls.assistantSend[calls.assistantSend.length - 1][0].turnId;
  setVal($('#chatInput'), 'go');
  click($('#chatSendBtn'));
  await wait(20);
  const t2 = calls.assistantSend[calls.assistantSend.length - 1][0].turnId;
  fire('evt:assistant-event', { turnId: t2, event: { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Recon', status: 'completed' }, { content: 'Exploit', status: 'in_progress' }] } } });
  await wait(5);
  check('build: TodoWrite renders a checklist', window.document.querySelectorAll('#chatMessages .todo-item').length >= 2, 'no todo items');
  fire('evt:assistant-event', { turnId: t2, event: { type: 'done', sessionId: 'sess-1' } });
  await wait(5);

  // 9b) Multi-chat: conversations run concurrently in the background
  click($('#chatNewBtn'));
  await wait(5);
  setVal($('#chatInput'), 'Audit chat A');
  click($('#chatSendBtn'));
  await wait(10);
  const turnA = calls.assistantSend[calls.assistantSend.length - 1][0].turnId;
  check('multichat: chat A turn is running', $('#chatSendBtn').textContent === 'Stop', 'A not busy');
  const stopsBefore = calls.assistantStop.length;
  // Switch to a brand-new chat B while A keeps running.
  click($('#chatNewBtn'));
  await wait(10);
  check('multichat: switching away does NOT stop chat A', calls.assistantStop.length === stopsBefore, 'A was stopped on switch');
  check('multichat: new chat B is idle', $('#chatSendBtn').textContent === 'Send', 'B shows busy');
  check('multichat: sidebar marks A as running', window.document.querySelectorAll('#chatList .chat-run-dot').length >= 1, 'no running dot');
  setVal($('#chatInput'), 'Audit chat B');
  click($('#chatSendBtn'));
  await wait(10);
  const turnB = calls.assistantSend[calls.assistantSend.length - 1][0].turnId;
  check('multichat: chat B starts its own turn', turnB && turnB !== turnA, 'B reused A turn');
  // Chat A streams + finishes in the background (B is on screen).
  fire('evt:assistant-event', { turnId: turnA, event: { type: 'text', text: 'ALPHA-FINDING' } });
  await wait(5);
  check('multichat: background output stays out of the active view', !/ALPHA-FINDING/.test($('#chatMessages').textContent), 'A leaked into B view');
  fire('evt:assistant-event', { turnId: turnA, event: { type: 'done', sessionId: 'sess-A' } });
  await wait(5);
  // Switch back to A: its background output persisted and renders.
  const aItem = Array.from(window.document.querySelectorAll('#chatList .chat-list-item')).find((el) => /Audit chat A/.test(el.textContent));
  check('multichat: chat A is in the sidebar', !!aItem, 'A missing from list');
  click(aItem);
  await wait(10);
  check('multichat: chat A kept its background output', /ALPHA-FINDING/.test($('#chatMessages').textContent), 'A text missing after switch');
  check('multichat: chat A idle after its done', $('#chatSendBtn').textContent === 'Send', 'A still busy');
  // Clean up B.
  fire('evt:assistant-event', { turnId: turnB, event: { type: 'done', sessionId: 'sess-B' } });
  await wait(5);

  // 10) WebSocket event → list + frames
  goto('websockets');
  fire('evt:ws-open', { id: 'w1', ts: Date.now(), url: 'wss://ex.com/s', host: 'ex.com' });
  await wait(5);
  check('ws: connection row rendered', window.document.querySelectorAll('#wsBody tr').length >= 1, 'no ws rows');
  check('ws: count updated', $('#wsCount').textContent === '1', 'wsCount=' + $('#wsCount').textContent);
  click(window.document.querySelector('#wsBody tr'));
  await wait(10);
  check('ws: getWs called on select', calls.getWs.length, 'getWs not called');
  check('ws: frames rendered', window.document.querySelectorAll('#wsFrames .ws-frame').length >= 1, 'no frames');

  // 11) Intercept event → editor + forward
  goto('intercept');
  fire('evt:intercept', { id: 'f9', method: 'POST', scheme: 'https', host: 'ex.com', path: '/login', httpVersion: '1.1',
    request: { headers: { host: 'ex.com' }, body: 'u=a' }, intercepted: true });
  await wait(5);
  check('intercept: editor populated', /POST \/login/.test($('#interceptEditor').value), 'editor=' + $('#interceptEditor').value.slice(0, 30));
  check('intercept: forward enabled', !$('#forwardBtn').disabled, 'forward disabled');
  check('intercept: count badge shown', !$('#interceptCount').classList.contains('hidden'), 'badge hidden');
  click($('#forwardBtn'));
  await wait(5);
  check('intercept: forward calls resolveIntercept', calls.resolveIntercept.length, 'resolveIntercept not called');

  // 12) Scope: loaded from scopeList, add rule
  check('scope: rules loaded on init', calls.scopeList.length >= 1, 'scopeList not called');
  check('scope: rule row rendered', window.document.querySelectorAll('#scopeBody tr').length >= 1, 'no scope rows');
  setVal($('#scopeHost'), 'evil.com');
  $('#scopeMode').value = 'exclude';
  click($('#scopeAddBtn'));
  await wait(5);
  check('scope: add calls scopeAdd', calls.scopeAdd.length >= 1, 'scopeAdd not called');

  // 13) Match & Replace: loaded, open new form, save
  check('matchreplace: rules loaded on init', calls.mrList.length >= 1, 'mrList not called');
  check('matchreplace: rule row rendered', window.document.querySelectorAll('#mrBody tr').length >= 1, 'no mr rows');
  click($('#mrNewBtn'));
  setVal($('#mrName'), 'Test');
  click($('#mrSaveBtn'));
  await wait(5);
  check('matchreplace: save calls mrAdd', calls.mrAdd.length >= 1, 'mrAdd not called');

  // 14) Intruder: template + count + start
  goto('intruder');
  setVal($('#intrTarget'), 'https://ex.com');
  setVal($('#intrTemplate'), 'GET /a?x=§1§ HTTP/1.1\nHost: ex.com\n\n');
  await wait(5);
  check('intruder: count called on template edit', calls.intruderCount.length >= 1, 'intruderCount not called');
  check('intruder: payload type selector present', !!$('#intrPayloadType'), 'no payload type select');
  const setTa = window.document.querySelector('#intrParams [data-param="items"]');
  check('intruder: simple-list editor rendered', !!setTa, 'no payload items editor');
  if (setTa) setVal(setTa, 'a\nb\nc');
  check('intruder: processing rule can be added', (() => { click($('#intrRuleAdd')); return window.document.querySelectorAll('#intrRules .intr-rule').length >= 1; })(), 'no rule row');
  click($('#intrStartBtn'));
  await wait(10);
  check('intruder: start calls intruderStart', calls.intruderStart.length >= 1, 'intruderStart not called');
  fire('evt:intruder-result', { attackId: 'atk1', row: { index: 0, payloads: ['a'], status: 200, length: 10, durationMs: 5 } });
  await wait(10);
  check('intruder: result row rendered', window.document.querySelectorAll('#intrBody tr').length >= 1, 'no intruder rows');

  // 15) Decoder: pick base64 encode
  goto('decoder');
  const decPick = window.document.querySelector('#decoderChain .decoder-pick');
  const decInput = window.document.querySelector('#decoderChain .decoder-input');
  check('decoder: transform dropdown populated', decPick && decPick.options.length > 2, 'dropdown empty');
  if (decInput && decPick) {
    setVal(decInput, 'hello');
    decPick.value = 'b64enc';
    decPick.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(10);
    const out = window.document.querySelector('#decoderChain .decoder-out');
    check('decoder: base64 output produced', out && out.value === 'aGVsbG8=', 'got ' + (out && out.value));
  }

  // 16) Comparer
  goto('comparer');
  setVal($('#cmpA'), 'alpha\nbeta');
  setVal($('#cmpB'), 'alpha\nBETA');
  click($('#cmpCompareBtn'));
  await wait(5);
  check('comparer: diff rendered', /diff-(ins|del|eq)/.test($('#cmpResult').innerHTML), 'no diff output');

  // 17) Discovery start
  goto('discovery');
  setVal($('#discBaseUrl'), 'https://ex.com');
  click($('#discStartBtn'));
  await wait(5);
  check('discovery: start calls startDiscovery', calls.startDiscovery.length >= 1, 'startDiscovery not called');
  const discJob = calls.startDiscovery[0][0].jobId; // app generates its own id
  fire('evt:disc-result', { jobId: discJob, row: { status: 200, length: 100, path: '/admin', mime: 'text/html' } });
  await wait(5);
  check('discovery: hit row rendered', window.document.querySelectorAll('#discBody tr').length >= 1, 'no disc rows');

  // 18) Sequencer start
  goto('sequencer');
  setVal(window.document.getElementById('seq-request'), 'GET https://ex.com/ HTTP/1.1\n\n');
  setVal(window.document.getElementById('seq-src-name'), 'SID');
  click(window.document.getElementById('seq-start'));
  await wait(5);
  check('sequencer: start calls startSequencer', calls.startSequencer.length >= 1, 'startSequencer not called');

  // 19) Collaborator: status loaded, start, interaction
  check('collaborator: status checked on init', calls.collabStatus.length >= 1, 'collabStatus not called');
  goto('collaborator');
  click($('#collabStartBtn'));
  await wait(10);
  check('collaborator: start calls collabStart', calls.collabStart.length >= 1, 'collabStart not called');
  fire('evt:collab-interaction', { id: 1, method: 'GET', url: '/ab12cd34ef', remote: '1.2.3.4', payload: 'ab12cd34ef', ts: Date.now(), httpVersion: '1.1', headers: {}, body: '' });
  await wait(5);
  check('collaborator: interaction row rendered', window.document.querySelectorAll('#collabBody tr').length >= 1, 'no collab rows');

  // 20) Sitemap renders from flows
  fire('evt:flow', { id: 'f1', method: 'GET', scheme: 'https', host: 'ex.com', path: '/a', url: 'https://ex.com/a', status: 200, mime: 'text/html', length: 15 });
  goto('sitemap');
  await wait(10);
  check('sitemap: tree rendered from flows', $('#smTree').children.length >= 1 || $('#smTree').querySelectorAll('*').length >= 1, 'tree empty');

  // 21) Export / import buttons
  goto('proxy');
  click($('#exportJsonBtn'));
  await wait(5);
  check('export: Export JSON calls exportJson', calls.exportJson.length >= 1, 'exportJson not called');

  // 22) Keyboard shortcuts
  const key = (k, opts = {}) =>
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, metaKey: true, bubbles: true, cancelable: true, ...opts }));
  // ensure a current flow is selected
  fire('evt:flow', { id: 'f1', method: 'GET', scheme: 'https', host: 'ex.com', path: '/a', url: 'https://ex.com/a', status: 200, mime: 'text/html', length: 15 });
  await wait(5);
  click(window.document.querySelector('#flowBody tr'));
  await wait(10);
  const tabsBefore = window.document.querySelectorAll('#repeaterTabs .tab').length;
  key('r'); // Cmd+R → send to repeater
  await wait(10);
  check('shortcut ⌘R sends to Repeater', window.document.querySelectorAll('#repeaterTabs .tab').length > tabsBefore && $('#view-repeater').classList.contains('active'), 'repeater not updated');
  key('i'); // Cmd+I → intruder
  await wait(10);
  check('shortcut ⌘I sends to Intruder', $('#view-intruder').classList.contains('active'), 'intruder not active');
  key('r', { shiftKey: true }); // Cmd+Shift+R → go to repeater tab
  await wait(5);
  check('shortcut ⌘⇧R opens Repeater tab', $('#view-repeater').classList.contains('active'), 'not on repeater');
  key('/'); // help overlay
  await wait(5);
  check('shortcut ⌘/ opens help overlay', !$('#shortcutHelp').classList.contains('hidden'), 'overlay hidden');
  check('shortcut help lists entries', window.document.querySelectorAll('#shortcutList .sc-row').length >= 5, 'no shortcut rows');
  key('r'); // Escape-less close test via close button
  click($('#shortcutClose'));
  await wait(5);
  check('shortcut help closes', $('#shortcutHelp').classList.contains('hidden'), 'overlay still open');
  // editor transform: select text in repeater request and Cmd+B
  goto('repeater');
  const rta = $('#repRequest');
  rta.value = 'hello';
  rta.focus();
  rta.selectionStart = 0; rta.selectionEnd = 5;
  key('b'); // base64 encode selection
  await wait(10);
  check('shortcut ⌘B base64-encodes selection', rta.value === 'aGVsbG8=', 'got ' + rta.value);
  // ⌘H HTML-encode
  rta.value = '<a>'; rta.focus(); rta.selectionStart = 0; rta.selectionEnd = 3;
  key('h');
  await wait(10);
  check('shortcut ⌘H html-encodes selection', /&lt;a&gt;/.test(rta.value), 'got ' + rta.value);
  // ⌘⇧D smart-decode (base64 → text)
  rta.value = 'aGVsbG8='; rta.focus(); rta.selectionStart = 0; rta.selectionEnd = 8;
  key('d', { shiftKey: true });
  await wait(10);
  check('shortcut ⌘⇧D smart-decodes selection', rta.value === 'hello', 'got ' + rta.value);

  // Remap: Settings rows render, and recording a new combo persists
  check('shortcuts: settings rows rendered', window.document.querySelectorAll('#shortcutSettings .sc-set-row').length >= 10, 'no remap rows');
  const setCallsBefore = calls.setSettings.length;
  const recBtn = window.document.querySelector('#shortcutSettings .sc-rec'); // first = send-repeater
  click(recBtn);
  await wait(5);
  key('j', { shiftKey: true, altKey: true }); // record mod+alt+shift+j
  await wait(10);
  check('shortcuts: remap persists via setSettings', calls.setSettings.length > setCallsBefore && calls.setSettings.some((a) => a[0] && a[0].shortcuts), 'setSettings(shortcuts) not called');
  check('shortcuts: reset button present', !!window.document.getElementById('shortcutResetBtn'), 'no reset button');

  // Auth panel: status loaded on init, sign-in/out wired
  check('auth: status checked on init', calls.authStatus.length >= 1, 'authStatus not called');
  check('auth: shows signed-in account + plan', /user@example\.com/.test($('#authDetail').textContent) && /max/i.test($('#authDetail').textContent), 'detail=' + $('#authDetail').textContent);
  check('auth: signed-in hides login button', $('#authLoginBtn').classList.contains('hidden'), 'login btn visible');
  click($('#authLogoutBtn'));
  await wait(10);
  check('auth: sign out calls authLogout', calls.authLogout.length >= 1, 'authLogout not called');

  // 23) Clear flows
  goto('proxy');
  click($('#clearFlowsBtn'));
  await wait(5);
  check('proxy: clear empties table', window.document.querySelectorAll('#flowBody tr').length === 0, 'rows remain');

  // ---- report ----
  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);
  console.log(`\n==== RENDERER QA: ${pass}/${results.length} passed ====`);
  for (const r of results) console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.ok ? '' : '  → ' + r.detail));
  if (errors.length) {
    console.log('\n==== RUNTIME ERRORS (' + errors.length + ') ====');
    errors.slice(0, 20).forEach((e) => console.log('  • ' + e.split('\n').slice(0, 3).join('\n    ')));
  }
  console.log('');
  process.exit(fail.length || errors.length ? 1 : 0);
})();
