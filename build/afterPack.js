'use strict';

// electron-builder afterPack hook: each DMG only needs the Claude Agent SDK
// binary for its own CPU, so drop the other architecture's (~240 MB) copy.
const fs = require('fs');
const path = require('path');
const { Arch } = require('builder-util');

exports.default = async function afterPack(ctx) {
  const keep = Arch[ctx.arch]; // 'arm64' | 'x64'
  const dir = path.join(
    ctx.appOutDir,
    `${ctx.packager.appInfo.productFilename}.app`,
    'Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai'
  );
  for (const arch of ['arm64', 'x64']) {
    if (arch !== keep) {
      fs.rmSync(path.join(dir, `claude-agent-sdk-darwin-${arch}`), { recursive: true, force: true });
    }
  }
};
