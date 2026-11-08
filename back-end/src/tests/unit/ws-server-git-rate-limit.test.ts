import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// run-unit-tests.ts discovers this wrapper during both unit and coverage runs.
// The owning test runs the real claude-code and codex-code ws-server.mjs with real
// git against a fake GitHub that answers 429: no credential in any output, and a
// refused base fetch is not reported as a missing branch (rose-builds-rose C18).
const owningTest = resolve(
  __dirname,
  '../../../../e2b-templates/claude-code/git-rate-limit.test.mjs'
);
const result = spawnSync(process.execPath, ['--test', owningTest], {
  encoding: 'utf8',
  timeout: 120_000,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
assert.ifError(result.error);
assert.equal(result.status, 0, 'sandbox git rate-limit contract failed');
assert.match(result.stdout, /# skipped 0\b/, 'Owning sandbox git tests must run without skips');
assert.match(result.stdout, /# pass 6\b/, 'All six sandbox git cases must run');
