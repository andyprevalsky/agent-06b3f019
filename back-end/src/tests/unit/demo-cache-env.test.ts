#!/usr/bin/env tsx
/**
 * DEMO cache env naming (2026-10-23 rename from "fast cache").
 *
 * DEMO_CACHE_* is the current spelling; the legacy FAST_MODE_CACHE_* /
 * FAST_CACHE_* names must keep working (prod Render/Fly env is unchanged) and win
 * while present, so an isolation harness that sets a legacy name to "" still
 * overrides an inherited DEMO_CACHE_* value.
 *
 * Run: npx tsx src/tests/unit/demo-cache-env.test.ts
 */

import assert from 'node:assert';
import { DEMO_CACHE_ENV_ALIASES, demoCacheEnv } from '../../providers/demoCacheEnv';
import { demoCacheWritesDisabled } from '../../providers/demoCacheAccountPolicy';

let passed = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

check('legacy name alone still works', () => {
  assert.equal(
    demoCacheEnv('DEMO_CACHE_DATABASE_URL', { FAST_MODE_CACHE_DATABASE_URL: 'legacy' }),
    'legacy'
  );
  assert.equal(demoCacheEnv('DEMO_CACHE_DB_POOL', { FAST_CACHE_DB_POOL: '4' }), '4');
});

check('DEMO_CACHE name alone works', () => {
  assert.equal(
    demoCacheEnv('DEMO_CACHE_DATABASE_URL', { DEMO_CACHE_DATABASE_URL: 'demo' }),
    'demo'
  );
});

check('legacy wins while present, even empty', () => {
  const env = { DEMO_CACHE_DATABASE_URL: 'demo', FAST_MODE_CACHE_DATABASE_URL: '' };
  assert.equal(demoCacheEnv('DEMO_CACHE_DATABASE_URL', env), '');
});

check('unset in both spellings is undefined', () => {
  assert.equal(demoCacheEnv('DEMO_CACHE_USE_LOCAL', {}), undefined);
});

check('every alias maps DEMO_CACHE_* to a legacy name', () => {
  for (const [name, legacy] of Object.entries(DEMO_CACHE_ENV_ALIASES)) {
    assert.ok(name.startsWith('DEMO_CACHE_'), name);
    assert.ok(/^FAST_(MODE_)?CACHE_/.test(legacy), legacy);
  }
});

check('read-only flag honours both spellings', () => {
  const saved = {
    legacy: process.env.FAST_MODE_CACHE_DISABLE_WRITE_THROUGH,
    demo: process.env.DEMO_CACHE_DISABLE_WRITE_THROUGH,
  };
  try {
    delete process.env.FAST_MODE_CACHE_DISABLE_WRITE_THROUGH;
    process.env.DEMO_CACHE_DISABLE_WRITE_THROUGH = '1';
    assert.equal(demoCacheWritesDisabled(), true);
    delete process.env.DEMO_CACHE_DISABLE_WRITE_THROUGH;
    process.env.FAST_MODE_CACHE_DISABLE_WRITE_THROUGH = 'true';
    assert.equal(demoCacheWritesDisabled(), true);
    process.env.FAST_MODE_CACHE_DISABLE_WRITE_THROUGH = '0';
    process.env.DEMO_CACHE_DISABLE_WRITE_THROUGH = '1';
    assert.equal(demoCacheWritesDisabled(), false);
  } finally {
    for (const [key, value] of [
      ['FAST_MODE_CACHE_DISABLE_WRITE_THROUGH', saved.legacy],
      ['DEMO_CACHE_DISABLE_WRITE_THROUGH', saved.demo],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

if (failures.length > 0) {
  process.stderr.write(`demo-cache-env: ${failures.length} failed\n${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`demo-cache-env: ${passed} passed\n`);
