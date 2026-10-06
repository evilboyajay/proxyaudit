/*
 * ProxyAudit Agent — MV3 service worker.
 *
 * Connects to the ProxyAudit desktop app over a loopback WebSocket and becomes
 * the app's hands in this Chrome: the Claude Build agent sends WHERE TO GO and
 * WHAT TO DO (navigate / getLinks / click / readPage / evaluate / setProxy),
 * this worker performs the visiting and info-gathering in a dedicated tab and
 * returns the results. When asked, it also points Chrome's proxy at ProxyAudit
 * so every request is captured.
 *
 * Authorized security testing only. You are responsible for only driving this
 * against targets you are authorized to test.
 */
'use strict';

const WS_URL = 'ws://127.0.0.1:9444';
const RECONNECT_MS = 3000;

let ws = null;
let controlledTabId = null;
let proxyPort = 8080;

// ----------------------------------------------------------- connection

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch (_) {
    return;
  }
  ws.onopen = () => {
    announce();
    setBadge('ok');
  };
  ws.onclose = () => {
    ws = null;
    setBadge('off');
    setTimeout(connect, RECONNECT_MS);
  };
  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
  ws.onmessage = (ev) => handleMessage(ev.data);
}

function announce() {
  send({ type: 'ready', info: { version: chrome.runtime.getManifest().version, ua: navigator.userAgent } });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

function setBadge(state) {
  try {
    chrome.action.setBadgeText({ text: state === 'ok' ? '●' : '' });
    chrome.action.setBadgeBackgroundColor({ color: state === 'ok' ? '#16a34a' : '#999999' });
  } catch (_) {}
}

// ----------------------------------------------------------- message loop

async function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (_) { return; }

  if (msg.type === 'hello') {
    if (typeof msg.proxyPort === 'number') proxyPort = msg.proxyPort;
    if (msg.autoProxy) { try { await applyProxy(proxyPort); } catch (_) {} }
    return;
  }

  if (msg.type !== 'cmd') return;
  const { id, cmd, params } = msg;
  try {
    const data = await runCommand(cmd, params || {});
    send({ type: 'result', id, ok: true, data });
  } catch (e) {
    send({ type: 'result', id, ok: false, error: (e && e.message) || String(e) });
  }
}

async function runCommand(cmd, p) {
  switch (cmd) {
    case 'navigate': return await navigate(p.url);
    case 'currentUrl': return { url: await currentUrl() };
    case 'getLinks': return { links: await getLinks(p.sameOrigin !== false) };
    case 'click': return await click(p.selector);
    case 'readPage': return await readPage(p.maxChars || 12000);
    case 'evaluate': return { value: await evaluate(p.expression) };
    case 'setProxy': return await applyProxy(p.proxyPort || proxyPort);
    case 'clearProxy': return await clearProxy();
    default: throw new Error('unknown command: ' + cmd);
  }
}

// ----------------------------------------------------------- tab control

async function ensureTab() {
  if (controlledTabId != null) {
    try {
      const t = await chrome.tabs.get(controlledTabId);
      if (t) return t;
    } catch (_) { controlledTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  controlledTabId = tab.id;
  return tab;
}

function waitForComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
  });
}

async function navigate(url) {
  if (!url) throw new Error('no URL');
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  const tab = await ensureTab();
  await chrome.tabs.update(tab.id, { url });
  await waitForComplete(tab.id);
  // small settle so late XHR/fetch fire
  await new Promise((r) => setTimeout(r, 500));
  return { url: await currentUrl() };
}

async function currentUrl() {
  if (controlledTabId == null) return null;
  try { const t = await chrome.tabs.get(controlledTabId); return t && t.url; } catch (_) { return null; }
}

async function inPage(func, args = []) {
  const tab = await ensureTab();
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func,
    args,
  });
  return res && res.result;
}

async function getLinks(sameOrigin) {
  return await inPage((same) => {
    const origin = location.origin;
    const set = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      try {
        const u = new URL(a.href, location.href);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        if (!same || u.origin === origin) set.add(u.href.split('#')[0]);
      } catch (_) {}
    }
    return Array.from(set);
  }, [sameOrigin]);
}

async function click(selector) {
  return await inPage((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, error: 'no element matches ' + sel };
    el.click();
    return { ok: true };
  }, [selector]);
}

async function readPage(maxChars) {
  return await inPage((max) => ({
    url: location.href,
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, max),
    links: Array.from(document.querySelectorAll('a[href]')).map((a) => a.href).slice(0, 300),
  }), [maxChars]);
}

async function evaluate(expression) {
  const tab = await ensureTab();
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: (expr) => {
      try {
        // eslint-disable-next-line no-new-func
        return { ok: true, value: new Function('return (' + expr + ')')() };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    },
    args: [expression],
  });
  const out = res && res.result;
  if (out && out.ok === false) throw new Error(out.error || 'evaluation error');
  return out ? out.value : undefined;
}

// ----------------------------------------------------------- proxy routing

async function applyProxy(port) {
  proxyPort = port || proxyPort;
  const config = {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: 'http', host: '127.0.0.1', port: Number(proxyPort) },
      // Don't proxy loopback — keeps our own WS and devtools off the proxy.
      bypassList: ['localhost', '127.0.0.1', '[::1]'],
    },
  };
  await chrome.proxy.settings.set({ value: config, scope: 'regular' });
  await chrome.storage.session.set({ proxyOn: true, proxyPort });
  return { proxyOn: true, proxyPort };
}

async function clearProxy() {
  await chrome.proxy.settings.clear({ scope: 'regular' });
  await chrome.storage.session.set({ proxyOn: false });
  return { proxyOn: false };
}

// ----------------------------------------------------------- popup bridge

chrome.runtime.onMessage.addListener((req, _sender, sendResponse) => {
  if (req && req.type === 'getStatus') {
    sendResponse({
      connected: !!(ws && ws.readyState === WebSocket.OPEN),
      controlledTabId,
      proxyPort,
    });
  } else if (req && req.type === 'reconnect') {
    connect();
    sendResponse({ ok: true });
  } else if (req && req.type === 'toggleProxy') {
    (req.on ? applyProxy(proxyPort) : clearProxy()).then((r) => sendResponse(r));
    return true; // async
  }
  return false;
});

// ----------------------------------------------------------- lifecycle

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
// Keep the service worker reconnecting even after it is idled out.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => connect());

connect();
