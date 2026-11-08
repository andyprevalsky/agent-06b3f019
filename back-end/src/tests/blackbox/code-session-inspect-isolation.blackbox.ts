import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('C15 keeps its Codex fallback while a sibling holds the funded cooldown', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--import',
      './src/tests/blackbox/code-session-inspect-cooldown.fixture.ts',
      '--test',
      '--test-name-pattern=C15:',
      'src/tests/blackbox/code-session-inspect.blackbox.ts',
    ],
    { env: process.env, encoding: 'utf8', timeout: 900_000 }
  );
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  assert.ifError(child.error);
  assert.equal(child.signal, null, 'the original C15 child completed');
  assert.equal(child.status, 0, 'the unchanged C15 assertions pass with a competing cooldown');
  assert.match(child.stdout, /ok \d+ - C15: a Claude usage limit/);
});
