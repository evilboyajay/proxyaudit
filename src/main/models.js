'use strict';

const { execFile } = require('child_process');
const https = require('https');

/**
 * Live Claude model list from the Anthropic Models API, authenticated with the
 * user's `claude login` OAuth token (read from the macOS Keychain, where Claude
 * Code stores it). Best-effort: returns null on any failure so the renderer can
 * fall back to a static lineup.
 */

let _cache = null;
let _cacheAt = 0;
const TTL = 10 * 60 * 1000; // 10 min

function readToken() {
  return new Promise((resolve) => {
    // macOS Keychain item created by Claude Code.
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 6000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        try {
          const j = JSON.parse(stdout);
          resolve((j.claudeAiOauth && j.claudeAiOauth.accessToken) || j.accessToken || null);
        } catch (_) {
          resolve(null);
        }
      }
    );
  });
}

function fetchModels(token) {
  return new Promise((resolve) => {
    const req = https.request(
      'https://api.anthropic.com/v1/models?limit=100',
      {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          'anthropic-beta': 'oauth-2025-04-20',
          'anthropic-version': '2023-06-01',
        },
        timeout: 8000,
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (Array.isArray(j.data)) {
              resolve(j.data.map((m) => ({ id: m.id, label: m.display_name || m.id })));
            } else {
              resolve(null);
            }
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

async function list(force) {
  if (!force && _cache && Date.now() - _cacheAt < TTL) return _cache;
  const token = await readToken();
  if (!token) return null;
  const models = await fetchModels(token);
  if (models && models.length) {
    _cache = models;
    _cacheAt = Date.now();
  }
  return models;
}

module.exports = { list };
