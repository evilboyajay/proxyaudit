'use strict';

let proxyOn = false;

function render(s) {
  const dot = document.getElementById('dot');
  const conn = document.getElementById('conn');
  const proxy = document.getElementById('proxy');
  const tab = document.getElementById('tab');
  const connected = !!(s && s.connected);
  dot.className = 'dot ' + (connected ? 'on' : 'off');
  conn.textContent = connected ? 'Connected' : 'Not connected';
  proxy.textContent = s && s.proxyPort ? '127.0.0.1:' + s.proxyPort : '—';
  tab.textContent = s && s.controlledTabId != null ? '#' + s.controlledTabId : '—';
}

function refresh() {
  chrome.runtime.sendMessage({ type: 'getStatus' }, render);
}

document.getElementById('reconnect').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'reconnect' }, () => setTimeout(refresh, 500));
});

document.getElementById('toggleProxy').addEventListener('click', () => {
  proxyOn = !proxyOn;
  chrome.runtime.sendMessage({ type: 'toggleProxy', on: proxyOn }, () => setTimeout(refresh, 300));
});

refresh();
setInterval(refresh, 1500);
