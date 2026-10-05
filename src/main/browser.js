'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// Known Chromium-family browsers on macOS, in preference order.
const CANDIDATES = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  },
  {
    id: 'chromium',
    name: 'Chromium',
    paths: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
  },
  {
    id: 'brave',
    name: 'Brave',
    paths: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  },
  {
    id: 'edge',
    name: 'Microsoft Edge',
    paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  },
];

function expand(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Return the installed Chromium-family browsers found on this machine. */
function detect() {
  const found = [];
  for (const c of CANDIDATES) {
    // Check both /Applications and ~/Applications for each.
    const all = c.paths.concat(
      c.paths.map((p) => path.join(os.homedir(), p.replace(/^\//, '')))
    );
    const hit = all.map(expand).find((p) => fs.existsSync(p));
    if (hit) found.push({ id: c.id, name: c.name, path: hit });
  }
  return found;
}

/**
 * Launch a Chromium-family browser pre-configured to route all traffic
 * (including loopback and WebSockets) through the proxy, in its own isolated
 * profile, and to accept the MITM certificate without any manual trust step —
 * the same convenience as Burp's embedded browser.
 *
 * @param {object} opts { port, binaryPath, profileDir }
 */
const CDP_PORT = 9333; // remote-debugging port for Build-agent browser control

function launch({ port, binaryPath, profileDir, startUrl, cdpPort }) {
  const browsers = detect();
  if (!browsers.length) {
    return {
      ok: false,
      error:
        'No Chromium-family browser found. Install Google Chrome, Chromium, Brave, or Microsoft Edge.',
    };
  }

  let bin = binaryPath;
  if (!bin || !fs.existsSync(bin)) bin = browsers[0].path;
  const chosen = browsers.find((b) => b.path === bin) || browsers[0];

  const profile =
    profileDir || path.join(os.homedir(), '.proxyaudit', 'browser-profile');
  fs.mkdirSync(profile, { recursive: true });

  const flags = [
    `--proxy-server=http://127.0.0.1:${port}`,
    // Force even localhost/loopback through the proxy so local apps are captured.
    '--proxy-bypass-list=<-loopback>',
    // Accept the MITM CA without an install step; --test-type hides the warning bar.
    '--ignore-certificate-errors',
    '--test-type',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-service-autorun',
    '--disable-background-networking',
    // Expose CDP so the Build agent can drive/crawl the page.
    `--remote-debugging-port=${cdpPort || CDP_PORT}`,
    '--remote-allow-origins=*',
    '--new-window',
    startUrl || 'about:blank',
  ];

  // The .app bundle path (strip /Contents/MacOS/<exe>).
  const appPath = bin.includes('.app/') ? bin.slice(0, bin.indexOf('.app') + 4) : bin;

  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    // Launch the binary directly as a detached child (works without macOS
    // LaunchServices and lets us detect spawn failures).
    const directSpawn = () => {
      try {
        const child = spawn(bin, flags, { detached: true, stdio: 'ignore' });
        child.on('error', (e) => done({ ok: false, error: e.message }));
        child.unref();
        // If no error fires almost immediately, consider it launched.
        setTimeout(() => done({ ok: true, browser: chosen.name }), 400);
      } catch (e) {
        done({ ok: false, error: e.message });
      }
    };

    // Prefer macOS `open -na <App> --args <flags>`: the sanctioned way to start
    // a fresh GUI instance from inside another app (e.g. Electron). Fall back to
    // a direct spawn if `open` is unavailable or fails.
    try {
      const opener = spawn('open', ['-na', appPath, '--args', ...flags], {
        stdio: 'ignore',
      });
      opener.on('error', () => directSpawn());
      opener.on('exit', (code) => {
        if (settled) return;
        if (code === 0) done({ ok: true, browser: chosen.name });
        else directSpawn();
      });
    } catch (_) {
      directSpawn();
    }
  });
}

module.exports = { detect, launch, CDP_PORT };
