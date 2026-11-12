import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// run-unit-tests.ts discovers this wrapper during both unit and coverage runs.
// The owning test runs the real claude-code and codex-code ws-server.mjs with real
// git: a fresh clone and a resumed workspace both commit as the GitHub account
// whose token pushes (never the unlinkable Rose Agent identity Vercel blocks).
const owningTest = resolve(
  __dirname,
  '../../../../e2b-templates/claude-code/git-identity.test.mjs'
);
const result = spawnSync(process.execPath, ['--test', owningTest], {
  encoding: 'utf8',
  timeout: 120_000,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
assert.ifError(result.error);
assert.equal(result.status, 0, 'sandbox git identity contract failed');
assert.match(
  result.stdout,
  /# skipped 0\b/,
  'Owning sandbox git identity tests must run without skips'
);
assert.match(result.stdout, /# pass 4\b/, 'All four sandbox git identity cases must run');
