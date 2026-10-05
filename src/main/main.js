'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  shell,
  dialog,
  clipboard,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { ProxyEngine } = require('./proxy/engine');
const { Store } = require('./store');
const { sendRequest } = require('./proxy/repeater');
const auditor = require('./audit/auditor');
const browser = require('./browser');
const { Intruder } = require('./intruder');
const { Sequencer } = require('./sequencer');
const { Discovery } = require('./discovery');
const { Scope } = require('./scope');
const { MatchReplace } = require('./matchreplace');
const { Collaborator } = require('./collaborator');
const exporter = require('./exporter');
const auth = require('./auth');
const { PluginHost } = require('./plugins');
const { Assistant } = require('./assistant');
const { ChatStore } = require('./chatstore');
const { BrowserControl } = require('./browsercontrol');
const models = require('./models');

const CA_DIR = path.join(os.homedir(), '.proxyaudit');
const SETTINGS_PATH = path.join(CA_DIR, 'settings.json');

let mainWindow = null;
const store = new Store();
let engine = null;
let settings = loadSettings();

// Feature singletons
const intruder = new Intruder();
const sequencer = new Sequencer();
const discovery = new Discovery();
const scope = new Scope(); // persists to ~/.proxyaudit/scope.json
const matchReplace = new MatchReplace({ dir: CA_DIR });
const collaborator = new Collaborator();
const pluginHost = new PluginHost();
const assistant = new Assistant({ store, workspace: path.join(CA_DIR, 'workspace') });
const chatStore = new ChatStore(); // persists to ~/.proxyaudit/chats

// Let the Build agent drive the proxied Chromium to generate captured traffic.
assistant.browse = (url) =>
  browser.launch({
    port: engine && engine.running ? engine.port : settings.port || 8080,
    binaryPath: settings.browser,
    startUrl: url,
  });
// CDP control so the Build agent can crawl/click pages (browser launched above
// already exposes the remote-debugging port).
assistant.browser = new BrowserControl({
  port: browser.CDP_PORT,
  launch: (url) => assistant.browse(url),
});

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (_) {
    return { port: 8080, model: 'sonnet' };
  }
}
function saveSettings() {
  try {
    fs.mkdirSync(CA_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  } catch (_) {
    /* ignore */
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Summary + in-scope flag for the renderer.
function summaryWithScope(flow) {
  return { ...store.summary(flow), inScope: scope.inScope(flow.url) };
}

function createEngine() {
  engine = new ProxyEngine({
    port: settings.port || 8080,
    caDir: CA_DIR,
    matchreplace: matchReplace,
  });

  engine.on('flow', (flow) => {
    store.addFlow(flow);
    send('evt:flow', summaryWithScope(flow));
    pluginHost.process(flow, 'request');
  });
  engine.on('flow-update', (flow) => {
    store.updateFlow(flow);
    send('evt:flow-update', summaryWithScope(flow));
    pluginHost.process(flow, 'response');
  });
  engine.on('intercept', (flow) => {
    send('evt:intercept', flow);
  });
  engine.on('ws-open', (conn) => {
    store.addWs(conn);
    send('evt:ws-open', {
      id: conn.id,
      ts: conn.ts,
      url: conn.url,
      host: conn.host,
    });
  });
  engine.on('ws-message', (connId, frame) => {
    store.addWsMessage(connId, frame);
    send('evt:ws-message', { connId, frame });
  });
  engine.on('ws-close', (connId) => {
    store.closeWs(connId);
    send('evt:ws-close', connId);
  });
  engine.on('status', (state) => send('evt:status', state));
  engine.on('error', (msg) => send('evt:error', msg));
}

// Forward feature-engine events to the renderer.
function wireFeatureEvents() {
  intruder.on('status', (s) => send('evt:intruder-status', s));
  intruder.on('error', (m) => send('evt:error', m));
  intruder.on('intruder-progress', (p) => send('evt:intruder-progress', p));
  intruder.on('intruder-result', (r) => send('evt:intruder-result', r));
  intruder.on('intruder-done', (d) => send('evt:intruder-done', d));

  sequencer.on('seq-progress', (p) => send('evt:seq-progress', p));
  sequencer.on('seq-done', (p) => send('evt:seq-done', p));
  sequencer.on('error', (m) => send('evt:error', m));

  discovery.on('disc-result', (p) => send('evt:disc-result', p));
  discovery.on('disc-progress', (p) => send('evt:disc-progress', p));
  discovery.on('disc-done', (p) => send('evt:disc-done', p));

  scope.on('changed', (rules) => send('evt:scope-changed', rules));

  collaborator.on('interaction', (rec) => send('evt:collab-interaction', rec));
  collaborator.on('status', (s) => send('evt:collab-status', s));
  collaborator.on('error', (m) => send('evt:error', m));

  pluginHost.on('log', (l) => send('evt:plugin-log', l));
  pluginHost.on('finding', (f) => send('evt:plugin-finding', f));
  pluginHost.on('changed', () => send('evt:plugin-changed'));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#ffffff',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Forward renderer console + crashes to the main stdout for debugging.
  mainWindow.webContents.on('console-message', (...a) => {
    const d = a[a.length - 1];
    if (d && typeof d === 'object') {
      console.log(`[renderer:${d.level}] ${d.message} (${d.sourceId || ''}:${d.lineNumber || ''})`);
    } else {
      console.log('[renderer]', a[1], a[2], `(${a[4] || ''}:${a[3] || ''})`);
    }
  });
  mainWindow.webContents.on('preload-error', (_e, p, err) =>
    console.log('[preload-error]', p, err && err.stack)
  );
  mainWindow.webContents.on('render-process-gone', (_e, d) =>
    console.log('[render-process-gone]', JSON.stringify(d))
  );
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Proxy',
      submenu: [
        { label: 'Reveal CA Certificate in Finder', click: () => revealCa() },
        {
          label: 'Copy CA Certificate Path',
          click: () => clipboard.writeText(engine ? engine.caPath() : ''),
        },
        { type: 'separator' },
        {
          label: 'Clear History',
          click: () => {
            store.clear();
            send('evt:cleared');
          },
        },
      ],
    },
    {
      // Custom View menu WITHOUT Reload (Cmd+R) / Force Reload (Cmd+Shift+R),
      // so those accelerators are free for the in-app shortcuts.
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function revealCa() {
  const p = engine ? engine.caPath() : path.join(CA_DIR, 'certs', 'ca.pem');
  if (fs.existsSync(p)) {
    shell.showItemInFolder(p);
  } else {
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: 'CA not generated yet',
      detail:
        'Start the proxy once so the CA certificate is generated, then try again.\n\nExpected location:\n' +
        p,
    });
  }
}

// ----------------------------- IPC -----------------------------
function registerIpc() {
  ipcMain.handle('proxy:start', async () => {
    if (!engine) createEngine();
    await engine.start();
    return engine.state();
  });
  ipcMain.handle('proxy:stop', async () => {
    if (engine) await engine.stop();
    return engine ? engine.state() : { running: false };
  });
  ipcMain.handle('proxy:status', async () =>
    engine ? engine.state() : { running: false, port: settings.port }
  );
  ipcMain.handle('proxy:setIntercept', async (_e, enabled) => {
    if (engine) engine.setIntercept(enabled);
    return engine ? engine.state() : null;
  });
  ipcMain.handle('intercept:resolve', async (_e, { flowId, decision, edited }) =>
    engine ? engine.resolveIntercept(flowId, decision, edited) : false
  );

  ipcMain.handle('flows:list', async () =>
    store.listFlows().map((f) => ({ ...f, inScope: scope.inScope(f.url) }))
  );
  ipcMain.handle('flows:get', async (_e, id) => store.getFlow(id));
  ipcMain.handle('flows:clear', async () => {
    store.clear();
    return true;
  });

  ipcMain.handle('ws:list', async () => store.listWs());
  ipcMain.handle('ws:get', async (_e, id) => store.getWs(id));

  ipcMain.handle('repeater:send', async (_e, spec) => sendRequest(spec));

  // ----------------------------- Intruder -----------------------------
  ipcMain.handle('intruder:count', async (_e, { attackType, template, payloadSets }) => {
    const { positions } = Intruder.parseTemplate(template);
    return {
      positions: positions.length,
      total: intruder.countRequests(attackType, positions, payloadSets),
    };
  });
  ipcMain.handle('intruder:start', async (_e, opts) => intruder.start(opts));
  ipcMain.handle('intruder:stop', async (_e, attackId) => intruder.stop(attackId));
  ipcMain.handle('intruder:result', async (_e, { attackId, index }) =>
    intruder.getResult(attackId, index)
  );

  // ----------------------------- Sequencer -----------------------------
  ipcMain.handle('sequencer:start', async (_e, opts) => sequencer.start(opts));
  ipcMain.handle('sequencer:stop', async (_e, { jobId }) => sequencer.stop(jobId));
  ipcMain.handle('sequencer:tokens', async (_e, { jobId }) =>
    sequencer.getTokens(jobId)
  );

  // ------------------------- Content discovery -------------------------
  ipcMain.handle('discovery:start', async (_e, opts) => discovery.start(opts));
  ipcMain.handle('discovery:stop', async (_e, jobId) => discovery.stop(jobId));
  ipcMain.handle('discovery:results', async (_e, jobId) =>
    discovery.getResults(jobId)
  );

  // ------------------------------ Scope --------------------------------
  ipcMain.handle('scope:list', async () => scope.list());
  ipcMain.handle('scope:add', async (_e, rule) => {
    const r = scope.add(rule);
    return { ok: !r.error, rule: r, rules: scope.list() };
  });
  ipcMain.handle('scope:remove', async (_e, id) => {
    scope.remove(id);
    return scope.list();
  });
  ipcMain.handle('scope:toggle', async (_e, { id, enabled }) => {
    scope.setEnabled(id, enabled);
    return scope.list();
  });
  ipcMain.handle('scope:check', async (_e, url) => scope.inScope(url));

  // -------------------------- Match & Replace --------------------------
  ipcMain.handle('matchrepl:list', async () => matchReplace.list());
  ipcMain.handle('matchrepl:add', async (_e, rule) => matchReplace.add(rule));
  ipcMain.handle('matchrepl:update', async (_e, { id, patch }) =>
    matchReplace.update(id, patch)
  );
  ipcMain.handle('matchrepl:remove', async (_e, id) => matchReplace.remove(id));
  ipcMain.handle('matchrepl:toggle', async (_e, { id, enabled }) =>
    matchReplace.setEnabled(id, enabled)
  );

  // ---------------------------- Collaborator ---------------------------
  ipcMain.handle('collab:status', async () => collaborator.state());
  ipcMain.handle('collab:start', async () => collaborator.start());
  ipcMain.handle('collab:stop', async () => collaborator.stop());
  ipcMain.handle('collab:generate', async () => collaborator.generatePayload());
  ipcMain.handle('collab:list', async () => collaborator.list());
  ipcMain.handle('collab:get', async (_e, id) => collaborator.getInteraction(id));

  // ------------------------- Export / import ---------------------------
  ipcMain.handle('export:json', async () => {
    const data = exporter.toJSON(store.flows);
    const res = await exporter.saveDialog({
      window: mainWindow,
      defaultName: 'proxy-history.json',
      data,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    return { ok: !res.canceled, path: res.filePath, count: store.flows.length };
  });
  ipcMain.handle('export:har', async () => {
    const data = JSON.stringify(exporter.toHAR(store.flows), null, 2);
    const res = await exporter.saveDialog({
      window: mainWindow,
      defaultName: 'proxy-history.har',
      data,
      filters: [{ name: 'HAR 1.2', extensions: ['har', 'json'] }],
    });
    return { ok: !res.canceled, path: res.filePath, count: store.flows.length };
  });
  ipcMain.handle('import:json', async () => {
    const res = await exporter.openDialog({
      window: mainWindow,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (res.canceled) return { ok: false, canceled: true, count: 0 };
    let flows;
    try {
      flows = exporter.fromJSON(res.text);
    } catch (e) {
      return { ok: false, error: e.message, count: 0 };
    }
    let added = 0;
    for (const flow of flows) {
      store.addFlow(flow);
      send('evt:flow', summaryWithScope(flow));
      added += 1;
    }
    return { ok: true, count: added, path: res.filePath };
  });

  // ------------------------------ Browser ------------------------------
  ipcMain.handle('browser:list', async () => browser.detect());
  ipcMain.handle('browser:open', async (_e, opts = {}) => {
    if (!engine) createEngine();
    let warning = null;
    if (!engine.running) {
      try {
        await engine.start();
      } catch (e) {
        // Port already in use likely means a proxy is already listening there,
        // so the browser can still route through it. Open anyway and warn.
        warning = 'Proxy did not start (' + e.message + '). Opening browser anyway.';
      }
    }
    const res = await browser.launch({
      port: engine.port || settings.port || 8080,
      binaryPath: opts.binaryPath || settings.browser,
    });
    if (warning && res.ok) res.warning = warning;
    return res;
  });

  // --------------------------- CA + settings ---------------------------
  ipcMain.handle('ca:path', async () =>
    engine ? engine.caPath() : path.join(CA_DIR, 'certs', 'ca.pem')
  );
  ipcMain.handle('ca:reveal', async () => {
    revealCa();
    return true;
  });
  ipcMain.handle('settings:get', async () => settings);
  ipcMain.handle('settings:set', async (_e, patch) => {
    settings = { ...settings, ...patch };
    saveSettings();
    if (engine && patch.port) engine.port = patch.port;
    return settings;
  });

  // ------------------------------- Audit -------------------------------
  // ----------------------------- Build / plugins ----------------------
  ipcMain.handle('plugins:list', async () => pluginHost.list());
  ipcMain.handle('plugins:read', async (_e, name) => pluginHost.read(name));
  ipcMain.handle('plugins:save', async (_e, { name, code }) => pluginHost.save(name, code));
  ipcMain.handle('plugins:delete', async (_e, name) => pluginHost.remove(name));
  ipcMain.handle('plugins:toggle', async (_e, { name, enabled }) =>
    pluginHost.setEnabled(name, enabled)
  );
  ipcMain.handle('plugins:template', async () => pluginHost.template());
  ipcMain.handle('plugins:run', async (_e, { code }) =>
    pluginHost.runCode(code, store.flows)
  );
  ipcMain.handle('plugins:findings', async () => pluginHost.listFindings());
  ipcMain.handle('plugins:clearFindings', async () => {
    pluginHost.clearFindings();
    return true;
  });

  // ------------------------- Build: Claude agent ----------------------
  ipcMain.handle('assistant:send', async (_e, { turnId, message, sessionId, model, agentMode }) =>
    assistant.chat({
      turnId,
      message,
      sessionId,
      model, // '' / undefined => assistant uses the account default
      agentMode,
      onEvent: (event) => send('evt:assistant-event', { turnId, event }),
    })
  );
  ipcMain.handle('assistant:stop', async (_e, turnId) => assistant.stop(turnId));
  ipcMain.handle('assistant:workspace', async () => assistant.workspace);
  ipcMain.handle('models:list', async (_e, force) => models.list(force));

  // ------------------------- Build: chat history ----------------------
  ipcMain.handle('chats:list', async () => chatStore.list());
  ipcMain.handle('chats:create', async (_e, title) => chatStore.create(title));
  ipcMain.handle('chats:get', async (_e, id) => chatStore.get(id));
  ipcMain.handle('chats:rename', async (_e, { id, title }) => chatStore.rename(id, title));
  ipcMain.handle('chats:delete', async (_e, id) => chatStore.remove(id));
  ipcMain.handle('chats:clear', async () => chatStore.clear());
  ipcMain.handle('chats:append', async (_e, { id, message }) => chatStore.appendMessage(id, message));
  ipcMain.handle('chats:setSession', async (_e, { id, sessionId }) => chatStore.setSession(id, sessionId));

  // ------------------------- Claude account auth ----------------------
  ipcMain.handle('auth:status', async () => auth.status());
  ipcMain.handle('auth:login', async () =>
    auth.login((line) => send('evt:auth-login', line))
  );
  ipcMain.handle('auth:logout', async () => auth.logout());

  ipcMain.handle('audit:check', async () => auditor.checkAuth());
  ipcMain.handle('audit:endpoint', async (_e, { jobId, flowId }) => {
    const flow = store.getFlow(flowId);
    if (!flow) return { error: 'Flow not found' };
    return runAuditJob(jobId, () =>
      auditor.auditEndpoint(flow, {
        model: settings.model,
        onDelta: (t) => send('evt:audit-delta', { jobId, text: t }),
      })
    );
  });
  ipcMain.handle('audit:js', async (_e, { jobId, flowId }) => {
    const flow = store.getFlow(flowId);
    if (!flow || !flow.response) return { error: 'Flow/response not found' };
    return runAuditJob(jobId, () =>
      auditor.auditJs(flow.url, flow.response.body, {
        model: settings.model,
        onDelta: (t) => send('evt:audit-delta', { jobId, text: t }),
      })
    );
  });
  ipcMain.handle('audit:allJs', async (_e, { jobId }) => {
    const files = store.jsFiles();
    send('evt:audit-delta', {
      jobId,
      text: `Found ${files.length} distinct JavaScript file(s) in history.\n\n`,
    });
    const results = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      send('evt:audit-delta', {
        jobId,
        text: `\n\n---\n## [${i + 1}/${files.length}] ${f.url}\n\n`,
      });
      try {
        const r = await auditor.auditJs(f.url, f.content, {
          model: settings.model,
          onDelta: (t) => send('evt:audit-delta', { jobId, text: t }),
        });
        results.push({ url: f.url, ...r });
      } catch (e) {
        send('evt:audit-delta', { jobId, text: `\n[error] ${e.message}\n` });
        results.push({ url: f.url, error: e.message });
      }
    }
    send('evt:audit-done', { jobId, result: { files: results.length } });
    return { files: results.length };
  });
}

async function runAuditJob(jobId, fn) {
  try {
    const result = await fn();
    send('evt:audit-done', { jobId, result });
    return result;
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    send('evt:audit-done', { jobId, result: { error: msg } });
    return { error: msg };
  }
}

// --------------------------- lifecycle --------------------------
app.whenReady().then(() => {
  createEngine();
  wireFeatureEvents();
  registerIpc();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (engine) engine.stop();
  if (collaborator) collaborator.stop();
  if (process.platform !== 'darwin') app.quit();
});
