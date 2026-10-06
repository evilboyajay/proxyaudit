# ProxyAudit Agent — Chrome extension

This extension turns **your own Chrome** into the ProxyAudit Build agent's
browser. The desktop app tells it *where to go and what to do* (navigate, read
links, read the page, click, set the proxy); the extension does the actual
visiting and info-gathering in a dedicated tab and streams results back over a
loopback WebSocket (`ws://127.0.0.1:9444`).

> **Authorized security testing only.** Only drive this against targets you are
> authorized to test.

## Load it (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Keep the ProxyAudit desktop app running. The toolbar badge turns green (●)
   when the extension is connected to the app.

The Build tab in ProxyAudit shows a **🧩 Extension** chip that goes green once
connected; the agent then prefers your Chrome over the launched test browser.

## Proxy routing (capture your browsing)

Open the extension popup and click **Toggle proxy routing** to point Chrome at
the ProxyAudit proxy (the app pushes the current proxy port automatically).
Loopback (`localhost`, `127.0.0.1`) is bypassed so the control channel and
devtools stay off the proxy. Toggle it off to restore normal browsing.

## How it works

- `background.js` — MV3 service worker: maintains the WebSocket to the app,
  executes commands with `chrome.tabs` / `chrome.scripting` in a controlled tab,
  and configures `chrome.proxy` on request. An alarm keeps it reconnecting.
- `popup.html` / `popup.js` — connection status, reconnect, proxy toggle.

Commands: `navigate`, `currentUrl`, `getLinks`, `click`, `readPage`,
`evaluate`, `setProxy`, `clearProxy`.
