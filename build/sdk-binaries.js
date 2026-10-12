'use strict';

// `npm run dist` builds DMGs for both arm64 and x64, so both of the Claude Agent
// SDK's macOS binaries must be in node_modules. npm only installs the one for
// this machine's CPU (even with --force), so fetch any missing one with
// `npm pack` and unpack it in place. afterPack.js then keeps just the right one
// in each DMG.
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const scope = path.join(root, 'node_modules', '@anthropic-ai');
const { version } = JSON.parse(
  fs.readFileSync(path.join(scope, 'claude-agent-sdk', 'package.json'), 'utf8')
);

for (const arch of ['arm64', 'x64']) {
  const name = `claude-agent-sdk-darwin-${arch}`;
  const dest = path.join(scope, name);
  const pkgJson = path.join(dest, 'package.json');
  if (fs.existsSync(pkgJson) && JSON.parse(fs.readFileSync(pkgJson, 'utf8')).version === version) continue;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-bin-'));
  const tgz = execSync(`npm pack @anthropic-ai/${name}@${version} --silent`, { cwd: tmp, encoding: 'utf8' }).trim();
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execSync(`tar -xzf "${path.join(tmp, tgz)}" -C "${dest}" --strip-components=1`);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`installed @anthropic-ai/${name}@${version}`);
}
