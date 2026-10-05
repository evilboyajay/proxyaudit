'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Claude account auth, driven through the user's `claude` CLI so it shares the
 * same claude.ai (OAuth) login Claude Code uses. The ANTHROPIC_API_KEY /
 * ANTHROPIC_AUTH_TOKEN env vars are stripped so a stale/invalid key can't
 * shadow the real subscription login.
 */

function cleanEnv() {
  const e = { ...process.env };
  delete e.ANTHROPIC_API_KEY;
  delete e.ANTHROPIC_AUTH_TOKEN;
  return e;
}

let _cli = null;
function cli() {
  if (_cli) return _cli;
  try {
    _cli = execSync('command -v claude', { encoding: 'utf8' }).trim();
  } catch (_) {
    /* not on PATH */
  }
  if (!_cli) {
    const guess = path.join(os.homedir(), '.local', 'bin', 'claude');
    if (fs.existsSync(guess)) _cli = guess;
  }
  return _cli || 'claude';
}

function status() {
  return new Promise((resolve) => {
    let out = '';
    const c = spawn(cli(), ['auth', 'status'], { env: cleanEnv() });
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('error', (e) => resolve({ loggedIn: false, error: e.message }));
    c.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch (_) {
        resolve({ loggedIn: /logged ?in/i.test(out), raw: out.slice(0, 300) });
      }
    });
  });
}

/**
 * Run `claude auth login`. It opens the default browser (Chrome) for the
 * claude.ai OAuth flow and completes via a localhost callback. onLine streams
 * its output so the UI can surface the URL if the CLI prints one.
 */
function login(onLine) {
  return new Promise((resolve) => {
    let out = '';
    let c;
    try {
      c = spawn(cli(), ['auth', 'login'], { env: cleanEnv() });
    } catch (e) {
      return resolve({ ok: false, error: e.message });
    }
    const feed = (d) => {
      const s = d.toString();
      out += s;
      if (onLine) onLine(s);
      // Surface any auth URL the CLI prints.
      const m = s.match(/https?:\/\/\S*(?:claude\.ai|anthropic)\S*/);
      if (m && onLine) onLine('__URL__' + m[0]);
    };
    c.stdout.on('data', feed);
    c.stderr.on('data', feed);
    c.on('error', (e) => resolve({ ok: false, error: e.message }));
    c.on('close', (code) => resolve({ ok: code === 0, code, out: out.slice(-800) }));
    // Safety timeout: don't hang forever if the flow needs TTY input.
    setTimeout(() => {
      try { c.kill(); } catch (_) {}
    }, 180000);
  });
}

function logout() {
  return new Promise((resolve) => {
    const c = spawn(cli(), ['auth', 'logout'], { env: cleanEnv() });
    c.on('error', (e) => resolve({ ok: false, error: e.message }));
    c.on('close', (code) => resolve({ ok: code === 0 }));
  });
}

module.exports = { status, login, logout };
