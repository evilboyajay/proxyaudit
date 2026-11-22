'use strict';

// Picks the version for an automatic release and prints `version=X.Y.Z` for
// $GITHUB_OUTPUT.
//
// - package.json holds the base version. Bump its major or minor by hand when
//   you want a bigger jump; CI never commits a version back.
// - If no tag yet covers that base, release the base itself.
// - Otherwise bump the patch of the newest vX.Y.* tag.
const { execSync } = require('child_process');
const path = require('path');

const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

const base = parse(require(path.join(__dirname, '..', '..', 'package.json')).version);

const tags = execSync('git tag -l "v*"', { encoding: 'utf8' })
  .split('\n')
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  .map(parse)
  .sort(cmp);

const latest = tags[tags.length - 1];
let next;
if (!latest || cmp(base, latest) > 0) {
  next = base;
} else {
  next = [latest[0], latest[1], latest[2] + 1];
}

const version = next.join('.');
const prev = latest ? `v${latest.join('.')}` : '';
process.stdout.write(`version=${version}\nprevious=${prev}\n`);
