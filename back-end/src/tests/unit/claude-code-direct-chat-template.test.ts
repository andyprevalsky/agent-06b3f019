import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// run-unit-tests.ts discovers this wrapper during both unit and coverage runs.
const owningTest = resolve(__dirname, '../../../../e2b-templates/claude-code/direct-chat.test.mjs');
const result = spawnSync(process.execPath, ['--test', owningTest], {
  encoding: 'utf8',
  timeout: 120_000,
});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
assert.ifError(result.error);
assert.equal(result.status, 0, 'Claude Code ws-server direct-chat contract failed');
assert.match(result.stdout, /# skipped 0\b/, 'Owning ws-server tests must run without skips');
