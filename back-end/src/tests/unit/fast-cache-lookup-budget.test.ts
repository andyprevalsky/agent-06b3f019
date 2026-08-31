#!/usr/bin/env tsx
/**
 * Fast Mode prisma lookup budget: a unique-token miss must not wait on a
 * multi-second shared-cache findMany before awaitCacheFirst can start live.
 *
 * Official 4-worker chat-lifecycle (2026-08-31) recorded prisma_find_many
 * misses at 3829/3833ms (hits stayed ≤635ms). awaitCacheFirst then started
 * Cerebras, so first-response blew the 5s ratchet. Cap the lookup, treat
 * timeout as a miss, and still fill memory if the late row is a hit.
 *
 * Run: npx tsx src/tests/unit/fast-cache-lookup-budget.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FAST_CACHE_LOOKUP_BUDGET_MS,
  FastCacheLookupBudgetExceededError,
  withLookupBudget,
} from '../../providers/fastCacheStore';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function testLookupBudgetBounds(): void {
  assert.ok(FAST_CACHE_LOOKUP_BUDGET_MS > 0, 'budget must be positive');
  assert.ok(
    FAST_CACHE_LOOKUP_BUDGET_MS <= 1000,
    `budget ${FAST_CACHE_LOOKUP_BUDGET_MS}ms must stay well under the 5s lifecycle ratchet`
  );
  assert.ok(
    FAST_CACHE_LOOKUP_BUDGET_MS >= 650,
    `budget ${FAST_CACHE_LOOKUP_BUDGET_MS}ms must exceed observed Fast Mode hits (≤635ms)`
  );
}

async function testResolvesWhenQueryBeatsBudget(): Promise<void> {
  const value = await withLookupBudget(Promise.resolve({ row_count: 1 }), 50);
  assert.deepEqual(value, { row_count: 1 });
}

async function testTimesOutHungFindMany(): Promise<void> {
  const hung = deferred<{ row_count: number }>();
  const started = Date.now();
  await assert.rejects(
    () => withLookupBudget(hung.promise, 40),
    (error: unknown) => {
      assert.ok(error instanceof FastCacheLookupBudgetExceededError);
      assert.equal(error.budgetMs, 40);
      return true;
    }
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `timeout must not wait on the hung query (elapsed ${elapsed}ms)`);
  hung.resolve({ row_count: 0 });
}

function testCacheGetManyRacesFindMany(): void {
  const repo = readFileSync(join(process.cwd(), 'src', 'providers', 'fastCacheStore.ts'), 'utf8');
  assert.ok(repo.includes('FAST_CACHE_LOOKUP_BUDGET_MS'), 'budget constant is exported');
  assert.match(
    repo,
    /withLookupBudget\(\s*findManyPromise\s*,\s*FAST_CACHE_LOOKUP_BUDGET_MS\s*\)/,
    'findMany must be raced against the lookup budget'
  );
  assert.ok(
    repo.includes('FastCacheLookupBudgetExceededError'),
    'timeout must be a dedicated miss, not a generic prisma throw'
  );
  assert.ok(repo.includes('timed_out'), 'timeout must be visible on the prisma span');
  const timeoutBlock = repo.slice(repo.indexOf('FastCacheLookupBudgetExceededError'));
  assert.ok(
    /hit:\s*false/.test(timeoutBlock) || timeoutBlock.includes('resolveKeysAsMiss'),
    'budget timeout must resolve as a miss so awaitCacheFirst can start live'
  );
  assert.ok(
    timeoutBlock.includes('fillMemoryFromLateRows') || timeoutBlock.includes('writeMemoryCache'),
    'a late hit after timeout must still populate memory cache'
  );
}

async function main(): Promise<void> {
  testLookupBudgetBounds();
  await testResolvesWhenQueryBeatsBudget();
  await testTimesOutHungFindMany();
  testCacheGetManyRacesFindMany();
  process.stdout.write('fast-cache lookup budget tests passed\n');
}

void main();
