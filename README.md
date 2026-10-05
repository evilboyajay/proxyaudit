# ProxyAudit

An open-source web-security testing proxy for macOS — a lightweight Burp Suite
alternative with a **Claude-powered auditor** built in. Intercepting proxy,
full history, Repeater, WebSocket capture, and automated AI security review of
every endpoint and JavaScript file you capture.

> ⚠️ **Authorized testing only.** Use this against systems you own or have
> explicit written permission to test. Intercepting other people's traffic may
> be illegal.

## Features

- **Proxy + history** — transparent HTTP/HTTPS interception (MITM with an
  auto-generated CA), full request/response capture with decompression.
- **Open browser** — launches Chrome/Chromium/Brave/Edge pre-wired to the proxy
  in an isolated profile, auto-accepting the MITM cert — zero manual setup.
- **Target / site map** — tree of hosts → paths built from captured traffic.
- **Intercept** — hold requests in-flight; edit method, path, and headers, then
  forward or drop.
- **Repeater** — resend and freely edit any request (method, URL, headers,
  body) across multiple tabs.
- **Intruder** — payload fuzzing with §positions§ and four attack types
  (Sniper, Battering ram, Pitchfork, Cluster bomb), live results table.
- **Sequencer** — collect many session tokens and analyze randomness (per-char
  and overall Shannon entropy, estimated bits, verdict).
- **Decoder** — stackable encode/decode: Base64, URL, HTML, Hex, ASCII, Gzip,
  JWT, plus smart-decode.
- **Comparer** — line- or word-level visual diff of two blobs.
- **Content discovery** — directory/file brute-forcing with a built-in or custom
  wordlist and concurrency.
- **Scope** — include/exclude host rules; filter history to in-scope only.
- **Match & Replace** — rewrite request/response parts as they pass through.
- **WebSockets** — live capture of WebSocket connections and every frame.
- **Collaborator** — Burp-Collaborator-style out-of-band interaction logger via
  a `cloudflared` quick tunnel; generate payload URLs and watch for HTTP
  callbacks (blind SSRF/XSS/XXE/webhooks).
- **Export / import** — save history as JSON or HAR 1.2; re-import JSON.
- **Build (plugins)** — a Burp-Extender-style workshop where you write JS
  security plugins that hook proxied traffic. Plugins call
  `register({ name, onRequest?, onResponse? })` and get an `api` with
  `log()`, `finding({title, severity, detail, flowId})`, and **`ai(prompt)`** —
  a Claude call using your `claude login` session, so you can build AI-powered
  checks with no API key. Run a plugin over captured history or toggle it Live
  to run on new traffic; findings are collectible and click through to the
  request in the Proxy tab. Plugins live in `~/.proxyaudit/plugins/`.

## Requirements

- macOS, Node.js 18+ (built on Node 24).
- **Audit:** the Claude CLI logged in once — run `claude login` in a terminal.
  (Alternatively, set `ANTHROPIC_API_KEY` in your environment.)
- **Collaborator (optional):** `cloudflared` — `brew install cloudflared`.
- **Open browser (optional):** any Chromium-family browser installed.

## Install & run

```bash
npm install
npm start
```

## First-time setup

1. **Start the proxy** — click **Start proxy** (default `127.0.0.1:8080`).
2. **Trust the CA** (needed for HTTPS):
   - Settings → **Reveal in Finder**, or menu **Proxy → Reveal CA Certificate**.
   - Double-click `ca.pem`, add it to the **login** keychain, then open it in
     Keychain Access and set **Trust → When using this certificate → Always
     Trust**.
3. **Point your browser/system at the proxy** — set HTTP **and** HTTPS proxy to
   `127.0.0.1:8080`. (System Settings → Network → Proxies, or a browser
   extension like FoxyProxy / SwitchyOmega.)
4. Browse your target. Traffic appears under **Proxy**.

## Using the auditor

- Make sure `claude login` has been run once. The sidebar shows
  **Claude: logged in** when ready (re-check from Settings).
- From **Proxy**, select a request → **◆ Audit endpoint** or **◆ Audit JS**.
- From **Audit**, click **◆ Audit all JS files** to review every distinct
  JavaScript file captured so far.
- Pick the model (haiku / sonnet / opus) in Settings. Bulk JS auditing is
  cheaper and faster on haiku or sonnet.

## Keyboard shortcuts (Burp-style)

On macOS the modifier is ⌘; use Ctrl on other platforms. Press **⌘/** any time to
see this list in-app.

| Shortcut | Action |
| --- | --- |
| ⌘R | Send the selected request to Repeater |
| ⌘I | Send the selected request to Intruder |
| ⌘⇧R | Jump to the Repeater tab |
| ⌘⇧I | Jump to the Intruder tab |
| ⌘↵ | Send / run (Repeater send, Intruder/Sequencer/Discovery start) |
| ⌘⇧C | Send the selected response to Comparer |
| ⌘B / ⌘⇧B | Base64 encode / decode the selected text in an editor |
| ⌘U / ⌘⇧U | URL encode / decode the selected text in an editor |
| ⌘H / ⌘⇧H | HTML encode / decode the selected text in an editor |
| ⌘⇧D | Smart-decode the selected text in an editor |
| ⌘/ | Show the shortcuts list |

"Selected request" is whatever is selected in the Proxy history or the Target
site map. **All shortcuts are remappable** in Settings → Keyboard shortcuts
(click “Change”, press the new combo); changes persist across restarts.

## Packaging a .app / .dmg

```bash
npm run dist     # builds dist/ProxyAudit-*.dmg (arm64 + x64)
npm run pack     # unpacked .app only, for quick local testing
```

Add a custom icon at `build/icon.icns` before building (electron-builder uses a
default icon otherwise).

## Architecture

```
src/
  main/
    main.js            Electron main: window, menu, IPC wiring
    store.js           In-memory capture store (flows + WebSocket conns)
    browser.js         Chromium launcher (proxy + cert bypass)
    intruder.js        Payload fuzzing engine (4 attack types)
    sequencer.js       Token randomness collection + entropy analysis
    discovery.js       Directory/file brute-forcing
    scope.js           Include/exclude target scope rules
    matchreplace.js    Request/response rewrite rules
    collaborator.js    Out-of-band logger via cloudflared tunnel
    exporter.js        JSON / HAR export + import
    plugins.js         Build: plugin host (vm sandbox, live + history runs)
    auth.js            Claude account sign-in/out via the claude CLI
    proxy/
      engine.js        MITM proxy (http-mitm-proxy): capture + intercept + M&R
      repeater.js      Standalone request sender for the Repeater tab
    audit/
      auditor.js       Claude Agent SDK auditor (uses `claude login`)
  preload/
    preload.js         contextBridge — the only renderer↔main surface
  renderer/
    index.html         UI shell
    styles.css         Dark theme
    transforms.js      Decoder transforms (client-side)
    diff.js            Comparer diff algorithm (client-side)
    sitemap.js         Site-map tree builder (client-side)
    app.js             All UI logic
test/
  renderer-qa.js       Headless jsdom QA harness (node test/renderer-qa.js)
```

The renderer is fully sandboxed (`contextIsolation`, no `nodeIntegration`); it
talks to the main process only through the whitelisted `window.api` bridge.

## Known limitations

- Proxy is HTTP/1.1 + WebSocket (no HTTP/2). Most targets negotiate down fine.
- Body editing during live **Intercept** is deferred to **Repeater**, where it
  is reliable; intercept supports method/path/header edits + forward/drop.
- Capture is in-memory for the session (not persisted to disk).

## License

MIT
