'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Path to the Claude Agent SDK's native `claude` binary in a packaged build.
 *
 * The SDK resolves its platform package (e.g.
 * @anthropic-ai/claude-agent-sdk-darwin-arm64) to a path inside app.asar.
 * electron-builder unpacks that binary to app.asar.unpacked, but the SDK still
 * spawns the app.asar path, which fails: executables can't run from inside an
 * asar archive. Returns undefined in development so the SDK's own lookup runs.
 */
let cached;
function claudeExecutable() {
  if (cached !== undefined) return cached || undefined;
  cached = null;
  try {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    const p = require.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${exe}`
    );
    const asar = `app.asar${path.sep}`;
    if (p.includes(asar)) {
      const unpacked = p.replace(asar, `app.asar.unpacked${path.sep}`);
      if (fs.existsSync(unpacked)) cached = unpacked;
    }
  } catch (_) {
    /* platform package missing: let the SDK report it */
  }
  return cached || undefined;
}

module.exports = { claudeExecutable };
