'use strict';

// Writes release notes in Markdown to stdout.
// Usage: node release-notes.js <version> <previous-tag> <checksums-file>
const { execSync } = require('child_process');
const fs = require('fs');

const [version, previous, sumsFile] = process.argv.slice(2);
const range = previous ? `${previous}..HEAD` : 'HEAD';
const log = execSync(`git log ${range} --no-merges --pretty=format:"- %s (%h)"`, {
  encoding: 'utf8',
}).trim();
const sums = fs.readFileSync(sumsFile, 'utf8').trim();

process.stdout.write(`## Download

| Mac | File |
| --- | --- |
| Apple Silicon (M1 and later) | **ProxyAudit-${version}-arm64.dmg** |
| Intel | **ProxyAudit-${version}.dmg** |

Open the DMG and drag **ProxyAudit** to Applications.

> **First launch:** the app is ad-hoc signed but not notarized by Apple, so macOS blocks it the first time. Go to **System Settings → Privacy & Security** and click **Open Anyway**, or run:
> \`\`\`
> xattr -dr com.apple.quarantine /Applications/ProxyAudit.app
> \`\`\`

## Changes${previous ? ` since ${previous}` : ''}

${log || '- Maintenance release'}

## Checksums (SHA-256)

\`\`\`
${sums}
\`\`\`

Website: https://evilboyajay.github.io/proxyaudit/

⚠️ Use ProxyAudit only on systems you own or are authorized to test.
`);
