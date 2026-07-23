#!/usr/bin/env tsx
/**
 * Regression test for the RCA (2026-07-15): under BLACKBOX_TEST_REPLAY_OUTBOUND=1,
 * fetchCapture wrapped the backend's global fetch with @with-logic/fast-forward's
 * FileSystemCache, whose has/get/set are SYNCHRONOUS fs (existsSync / readFileSync
 * / writeFileSync). fast-forward calls them synchronously (no await), so every
 * outbound cache MISS did a synchronous writeFileSync (recording the response,
 * incl. large LLM bodies) on the event-loop thread. Under concurrent blackbox
 * load this stalled the loop ~1s (measured: /health 800-1200ms), the backend went
 * unresponsive ("fetch failed" x155 across a full suite), and agent background
 * work timed out to FAILED.
 *
 * The fix: NonBlockingFileCache serves reads from memory (lazy-loaded, memoized)
 * and flushes writes ASYNCHRONOUSLY, keeping the same synchronous Cache interface.
 *
 * This test fails if either (a) fetchCapture reverts to the sync FileSystemCache,
 * or (b) NonBlockingFileCache.set() ever blocks on a synchronous disk write.
 */

import assert from 'node:assert';
import {
  existsSync,
  mkdtempSync,
  readFileSync as readSource,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NonBlockingFileCache } from '../../providers/nonBlockingFetchCache';

const writeLine = (m: string): void => process.stdout.write(`${m}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function run(): Promise<void> {
  // ── (1) Wiring guard: fetchCapture must NOT use the sync FileSystemCache ──
  const src = readSource(join(__dirname, '../../providers/fetchCapture.ts'), 'utf8');
  assert.ok(src.includes('NonBlockingFileCache'), 'fetchCapture must use NonBlockingFileCache');
  assert.ok(
    !src.includes('new FileSystemCache('),
    'fetchCapture must NOT construct the synchronous FileSystemCache (blocks the event loop)'
  );

  const dir = mkdtempSync(join(tmpdir(), 'nbfc-'));
  const cache = new NonBlockingFileCache({ cacheDir: dir, namespace: 'outbound-fetch' });
  const nsDir = join(dir, 'outbound-fetch');

  // ── (2) set() is non-blocking: memory is immediate, disk is deferred ──
  const bigKey = 'k-big';
  const bigValue = { body: 'x'.repeat(2_000_000) }; // 2MB, like a large LLM body
  const t0 = Date.now();
  cache.set(bigKey, bigValue);
  const setMs = Date.now() - t0;
  assert.ok(setMs < 50, `set() must not block on disk (took ${setMs}ms for a 2MB value)`);

  // value is immediately replayable from memory...
  assert.deepStrictEqual(cache.get(bigKey), bigValue, 'get() must serve the value from memory');
  assert.strictEqual(cache.has(bigKey), true, 'has() must see the just-set key');

  // ...but the disk write is asynchronous (not yet flushed synchronously).
  const bigPath = join(nsDir, `${createHash('sha256').update(bigKey).digest('hex')}.json`);
  // The sync FileSystemCache would have the file on disk already; the async one
  // flushes on a later tick.
  await sleep(200);
  assert.ok(existsSync(bigPath), 'async write must eventually flush to disk');

  // ── (3) Disk-seeded fixtures (how blackbox tests seed) are read + memoized ──
  const seededKey = 'k-seeded';
  const seededPath = join(nsDir, `${createHash('sha256').update(seededKey).digest('hex')}.json`);
  writeFileSync(
    seededPath,
    JSON.stringify({ key: seededKey, value: { seeded: true }, timestamp: Date.now() }),
    'utf8'
  );
  const fresh = new NonBlockingFileCache({ cacheDir: dir, namespace: 'outbound-fetch' });
  assert.strictEqual(fresh.has(seededKey), true, 'has() must discover a disk-seeded fixture');
  assert.deepStrictEqual(
    fresh.get(seededKey),
    { seeded: true },
    'get() must read a seeded fixture'
  );

  // ── (4) delete + clear behave to the Cache contract ──
  assert.strictEqual(fresh.delete(seededKey), true, 'delete() returns true when the entry existed');
  assert.strictEqual(fresh.has(seededKey), false, 'delete() removes memory + disk');
  const deletedUndefinedKey = 'k-deleted-undefined';
  const deletedUndefinedPath = join(
    nsDir,
    `${createHash('sha256').update(deletedUndefinedKey).digest('hex')}.json`
  );
  fresh.set(deletedUndefinedKey, undefined);
  assert.strictEqual(
    fresh.delete(deletedUndefinedKey),
    true,
    'delete() recognizes a present undefined value'
  );
  await sleep(50);
  assert.strictEqual(
    existsSync(deletedUndefinedPath),
    false,
    'a deferred undefined write must not recreate a deleted entry'
  );

  // clear() wipes memory synchronously and disk asynchronously; wait for the
  // just-set async write to flush, clear, then wait for clear's async unlinks.
  fresh.set('k-clear', { a: 1 });
  await sleep(150);
  fresh.clear();
  await sleep(150);
  assert.strictEqual(fresh.has('k-clear'), false, 'clear() wipes memory + disk');
  assert.strictEqual(
    readdirSync(nsDir).filter((f) => f.endsWith('.json')).length,
    0,
    'clear() removes every fixture file'
  );

  writeLine('non-blocking-fetch-cache tests passed');
}

run().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
