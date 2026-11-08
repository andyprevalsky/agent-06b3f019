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
  await cache.flushPendingWrites();
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
  await fresh.flushPendingWrites();
  assert.strictEqual(
    existsSync(deletedUndefinedPath),
    false,
    'a deferred undefined write must not recreate a deleted entry'
  );

  // delete/clear must win even when they race a large in-flight write.
  const deletedDuringWriteKey = 'k-deleted-during-write';
  const deletedDuringWritePath = join(
    nsDir,
    `${createHash('sha256').update(deletedDuringWriteKey).digest('hex')}.json`
  );
  fresh.set(deletedDuringWriteKey, { body: 'z'.repeat(8_000_000) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.strictEqual(
    fresh.delete(deletedDuringWriteKey),
    true,
    'delete() recognizes the in-memory entry while its write is pending'
  );
  await fresh.flushPendingWrites();
  assert.strictEqual(
    existsSync(deletedDuringWritePath),
    false,
    'an older in-flight write must not recreate a deleted fixture'
  );

  fresh.set('k-clear', { body: 'y'.repeat(8_000_000) });
  fresh.clear();
  await fresh.flushPendingWrites();
  assert.strictEqual(fresh.has('k-clear'), false, 'clear() wipes memory + disk');
  assert.strictEqual(
    readdirSync(nsDir).filter((f) => f.endsWith('.json')).length,
    0,
    'clear() removes every fixture file'
  );

  // Serialization failures occur inside setImmediate; they must stay
  // best-effort instead of becoming process-level uncaught exceptions.
  const circular: { self?: unknown } = {};
  circular.self = circular;
  fresh.set('k-circular', circular);
  fresh.set('k-bigint', { value: 1n });
  await fresh.flushPendingWrites();
  assert.strictEqual(fresh.get('k-circular'), circular, 'circular values remain memory-resident');
  assert.deepStrictEqual(
    fresh.get('k-bigint'),
    { value: 1n },
    'bigint values remain memory-resident'
  );
  assert.strictEqual(
    readdirSync(nsDir).filter((f) => f.endsWith('.tmp')).length,
    0,
    'failed serialization must not leave temporary files'
  );

  // ── (5) Memory bookkeeping never retains whole request keys ──
  // Replay keys embed the full outbound body. A 16M-character chat prompt kept
  // one 32 MB key per recorded call alive for the server's lifetime and drove
  // the shard-2 coverage server to a V8 heap OOM (2026-11-07). In-memory maps
  // and sets must be keyed by the same sha256 digest used for the file name.
  const retention = new NonBlockingFileCache({ cacheDir: dir, namespace: 'retention' });
  const hugeKey = `call:${JSON.stringify(['https://api.example.test', 'POST', 'y'.repeat(1_000_000)])}`;
  retention.set(hugeKey, { status: 200 });
  assert.strictEqual(retention.has(hugeKey), true, 'large keys must still replay');
  await retention.flushPendingWrites();
  assert.deepStrictEqual(retention.get(hugeKey), { status: 200 }, 'large keys replay after flush');
  retention.delete(hugeKey);
  retention.set(hugeKey, { status: 201 });
  await retention.flushPendingWrites();
  const hugeEntry = JSON.parse(
    readSource(
      join(dir, 'retention', `${createHash('sha256').update(hugeKey).digest('hex')}.json`),
      'utf8'
    )
  ) as { key: string; value: unknown };
  assert.strictEqual(hugeEntry.key, hugeKey, 'the fixture file still records the full key');
  for (const [field, held] of Object.entries(retention)) {
    const ids =
      held instanceof Map ? [...held.keys()] : held instanceof Set ? [...held.values()] : [];
    for (const id of ids) {
      assert.ok(
        typeof id !== 'string' || id.length <= 64,
        `${field} retained a ${String(id.length)}-character request key instead of its digest`
      );
    }
  }

  writeLine('non-blocking-fetch-cache tests passed');
}

run().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
