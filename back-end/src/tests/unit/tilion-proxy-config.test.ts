import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

function selected(value?: string): string {
  const env = { ...process.env };
  delete env.TILION_PROXY_TYPE;
  if (value !== undefined) env.TILION_PROXY_TYPE = value;
  return execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import { TILION_DEFAULT_PROXY_TYPE } from './src/providers/browser/tilionConfig.ts'; console.log(TILION_DEFAULT_PROXY_TYPE);",
    ],
    { env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }
  ).trim();
}

test('Tilion defaults to direct without a process override', () => {
  assert.equal(selected(), 'direct');
});

test('Tilion honors an explicit residential process override', () => {
  assert.equal(selected('residential'), 'residential');
});

test('Tilion rejects an unsupported process proxy override', () => {
  assert.throws(() => selected('unsupported'));
});
