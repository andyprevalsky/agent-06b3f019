#!/usr/bin/env tsx
/**
 * FAST_MODE_CACHE_DISABLE_WRITE_THROUGH makes the backend an authoritative
 * read-only Fast Mode cache client, matching the Python worker
 * (agents/providers/fast_cache/context.py:cache_writes_disabled).
 *
 * Incident 40ebcb24 (test-mass-agent-run-0, 2026-10-02): the pre-deploy shared
 * July cache batch set the flag, the worker wrote nothing, but the backend
 * chat router still stored its live Cerebras decision into the shared prod
 * cache (`fast_cache.chat_router_stored`), so the next run would replay a live
 * recording and hide the regression.
 *
 * Run: npx tsx src/tests/unit/fast-cache-read-only.test.ts
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  demoCacheWriteEnabled,
  fastCacheWritesDisabled,
  resolveFastModeWriteEnabled,
} from '../../providers/fastCacheAccountPolicy';
import { cacheSet } from '../../providers/fastCacheStore';

const ANDY = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const FLAG = 'FAST_MODE_CACHE_DISABLE_WRITE_THROUGH';

let passed = 0;
const failures: string[] = [];
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    process.stdout.write(`  ❌ ${name}\n`);
  }
}

function withFlag(value: string | undefined, fn: () => void): void {
  const previous = process.env[FLAG];
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous;
  }
}

async function main(): Promise<void> {
  await test('read-only flag accepts the same truthy values as the Python worker', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      withFlag(value, () => assert.equal(fastCacheWritesDisabled(), true, value));
    }
    for (const value of [undefined, '', '0', 'false', 'off']) {
      withFlag(value, () => assert.equal(fastCacheWritesDisabled(), false, String(value)));
    }
  });

  await test('read-only mode disables DEMO and write-through-account writes', () => {
    withFlag('1', () => {
      assert.equal(demoCacheWriteEnabled(true), false);
      assert.equal(resolveFastModeWriteEnabled(true, ANDY), false);
      assert.equal(resolveFastModeWriteEnabled(undefined, ANDY), false);
    });
    withFlag(undefined, () => {
      assert.equal(demoCacheWriteEnabled(true), true);
      assert.equal(demoCacheWriteEnabled(false), false);
      assert.equal(resolveFastModeWriteEnabled(undefined, ANDY), true);
      assert.equal(resolveFastModeWriteEnabled(false, ANDY), false);
    });
  });

  await test('agentFastMode derives writeEnabled from the read-only policy', () => {
    const store = readFileSync(
      join(process.cwd(), 'src', 'providers', 'fastCacheStore.ts'),
      'utf8'
    );
    assert.match(store, /writeEnabled: demoCacheWriteEnabled\(enabled\)/);
  });

  await test('cacheSet never reaches the cache database in read-only mode', async () => {
    const previousUrl = process.env.FAST_MODE_CACHE_DATABASE_URL;
    const previousFlag = process.env[FLAG];
    const previousNodeEnv = process.env.NODE_ENV;
    // Without a cache URL outside production, any DB access throws — so a
    // resolved cacheSet proves the write never touched the store.
    delete process.env.FAST_MODE_CACHE_DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env[FLAG] = '1';
    try {
      await cacheSet({
        key: 'fastmode:v42:llm:4ae3193053ac1d8f:chat_router:c:read-only-probe',
        kind: 'llm',
        goalHash: '4ae3193053ac1d8f',
        value: { json: '{}' },
      });
    } finally {
      if (previousUrl === undefined) delete process.env.FAST_MODE_CACHE_DATABASE_URL;
      else process.env.FAST_MODE_CACHE_DATABASE_URL = previousUrl;
      if (previousFlag === undefined) delete process.env[FLAG];
      else process.env[FLAG] = previousFlag;
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) {
    for (const failure of failures) process.stdout.write(`  - ${failure}\n`);
    process.exit(1);
  }
}

void main();
