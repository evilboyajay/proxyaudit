'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Whitelisted event channels the renderer may subscribe to.
const EVENTS = [
  'evt:flow',
  'evt:flow-update',
  'evt:intercept',
  'evt:ws-open',
  'evt:ws-message',
  'evt:ws-close',
  'evt:status',
  'evt:error',
  'evt:audit-delta',
  'evt:audit-done',
  'evt:cleared',
  // Intruder
  'evt:intruder-status',
  'evt:intruder-progress',
  'evt:intruder-result',
  'evt:intruder-done',
  // Sequencer
  'evt:seq-progress',
  'evt:seq-done',
  // Content discovery
  'evt:disc-progress',
  'evt:disc-result',
  'evt:disc-done',
  // Scope
  'evt:scope-changed',
  // Collaborator
  'evt:collab-interaction',
  'evt:collab-status',
  // Claude account auth
  'evt:auth-login',
  // Build / plugins
  'evt:plugin-log',
  'evt:plugin-finding',
  'evt:plugin-changed',
  // Build: Claude agent
  'evt:assistant-event',
];

contextBridge.exposeInMainWorld('api', {
  // Proxy control
  startProxy: () => ipcRenderer.invoke('proxy:start'),
  stopProxy: () => ipcRenderer.invoke('proxy:stop'),
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  setIntercept: (enabled) => ipcRenderer.invoke('proxy:setIntercept', enabled),
  resolveIntercept: (flowId, decision, edited) =>
    ipcRenderer.invoke('intercept:resolve', { flowId, decision, edited }),

  // History
  listFlows: () => ipcRenderer.invoke('flows:list'),
  getFlow: (id) => ipcRenderer.invoke('flows:get', id),
  clearFlows: () => ipcRenderer.invoke('flows:clear'),

  // WebSocket
  listWs: () => ipcRenderer.invoke('ws:list'),
  getWs: (id) => ipcRenderer.invoke('ws:get', id),

  // Repeater
  sendRequest: (spec) => ipcRenderer.invoke('repeater:send', spec),

  // Intruder
  intruderCount: (spec) => ipcRenderer.invoke('intruder:count', spec),
  intruderStart: (opts) => ipcRenderer.invoke('intruder:start', opts),
  intruderStop: (attackId) => ipcRenderer.invoke('intruder:stop', attackId),
  intruderResult: (attackId, index) =>
    ipcRenderer.invoke('intruder:result', { attackId, index }),

  // Sequencer
  startSequencer: (opts) => ipcRenderer.invoke('sequencer:start', opts),
  stopSequencer: (jobId) => ipcRenderer.invoke('sequencer:stop', { jobId }),
  getSeqTokens: (jobId) => ipcRenderer.invoke('sequencer:tokens', { jobId }),

  // Content discovery
  startDiscovery: (opts) => ipcRenderer.invoke('discovery:start', opts),
  stopDiscovery: (jobId) => ipcRenderer.invoke('discovery:stop', jobId),
  discoveryResults: (jobId) => ipcRenderer.invoke('discovery:results', jobId),

  // Scope
  scopeList: () => ipcRenderer.invoke('scope:list'),
  scopeAdd: (rule) => ipcRenderer.invoke('scope:add', rule),
  scopeRemove: (id) => ipcRenderer.invoke('scope:remove', id),
  scopeToggle: (id, enabled) => ipcRenderer.invoke('scope:toggle', { id, enabled }),
  scopeCheck: (url) => ipcRenderer.invoke('scope:check', url),

  // Match & Replace
  mrList: () => ipcRenderer.invoke('matchrepl:list'),
  mrAdd: (rule) => ipcRenderer.invoke('matchrepl:add', rule),
  mrUpdate: (id, patch) => ipcRenderer.invoke('matchrepl:update', { id, patch }),
  mrRemove: (id) => ipcRenderer.invoke('matchrepl:remove', id),
  mrToggle: (id, enabled) => ipcRenderer.invoke('matchrepl:toggle', { id, enabled }),

  // Collaborator
  collabStatus: () => ipcRenderer.invoke('collab:status'),
  collabStart: () => ipcRenderer.invoke('collab:start'),
  collabStop: () => ipcRenderer.invoke('collab:stop'),
  collabGenerate: () => ipcRenderer.invoke('collab:generate'),
  collabList: () => ipcRenderer.invoke('collab:list'),
  collabGet: (id) => ipcRenderer.invoke('collab:get', id),

  // Export / import
  exportJson: () => ipcRenderer.invoke('export:json'),
  exportHar: () => ipcRenderer.invoke('export:har'),
  importJson: () => ipcRenderer.invoke('import:json'),

  // Browser
  listBrowsers: () => ipcRenderer.invoke('browser:list'),
  openBrowser: (opts) => ipcRenderer.invoke('browser:open', opts || {}),

  // CA + settings
  caPath: () => ipcRenderer.invoke('ca:path'),
  revealCa: () => ipcRenderer.invoke('ca:reveal'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // Build / plugins
  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginRead: (name) => ipcRenderer.invoke('plugins:read', name),
  pluginSave: (name, code) => ipcRenderer.invoke('plugins:save', { name, code }),
  pluginDelete: (name) => ipcRenderer.invoke('plugins:delete', name),
  pluginToggle: (name, enabled) => ipcRenderer.invoke('plugins:toggle', { name, enabled }),
  pluginTemplate: () => ipcRenderer.invoke('plugins:template'),
  pluginRun: (code) => ipcRenderer.invoke('plugins:run', { code }),
  pluginFindings: () => ipcRenderer.invoke('plugins:findings'),
  pluginClearFindings: () => ipcRenderer.invoke('plugins:clearFindings'),

  // Build: Claude agent
  assistantSend: (opts) => ipcRenderer.invoke('assistant:send', opts),
  assistantStop: (turnId) => ipcRenderer.invoke('assistant:stop', turnId),
  assistantWorkspace: () => ipcRenderer.invoke('assistant:workspace'),
  listModels: (force) => ipcRenderer.invoke('models:list', force),

  // Build: chat history
  chatsList: () => ipcRenderer.invoke('chats:list'),
  chatCreate: (title) => ipcRenderer.invoke('chats:create', title),
  chatGet: (id) => ipcRenderer.invoke('chats:get', id),
  chatRename: (id, title) => ipcRenderer.invoke('chats:rename', { id, title }),
  chatDelete: (id) => ipcRenderer.invoke('chats:delete', id),
  chatsClear: () => ipcRenderer.invoke('chats:clear'),
  chatAppend: (id, message) => ipcRenderer.invoke('chats:append', { id, message }),
  chatSetSession: (id, sessionId) => ipcRenderer.invoke('chats:setSession', { id, sessionId }),

  // Claude account auth
  authStatus: () => ipcRenderer.invoke('auth:status'),
  authLogin: () => ipcRenderer.invoke('auth:login'),
  authLogout: () => ipcRenderer.invoke('auth:logout'),

  // Audit
  checkAuth: () => ipcRenderer.invoke('audit:check'),
  auditEndpoint: (jobId, flowId) =>
    ipcRenderer.invoke('audit:endpoint', { jobId, flowId }),
  auditJs: (jobId, flowId) => ipcRenderer.invoke('audit:js', { jobId, flowId }),
  auditAllJs: (jobId) => ipcRenderer.invoke('audit:allJs', { jobId }),

  // Events
  on: (channel, handler) => {
    if (!EVENTS.includes(channel)) return () => {};
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
