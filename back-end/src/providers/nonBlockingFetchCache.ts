/**
 * Non-blocking drop-in replacement for @with-logic/fast-forward's
 * FileSystemCache, used ONLY by fetchCapture.ts (blackbox test infrastructure,
 * never in production).
 *
 * Why this exists — RCA (2026-07-15):
 * fetchCapture wraps the backend's global `fetch`. Under BLACKBOX_TEST_REPLAY_
 * OUTBOUND=1, every outbound call goes through the fast-forward cache. The
 * library's FileSystemCache does SYNCHRONOUS fs on the event-loop thread:
 * `has` → existsSync, `get` → readFileSync, `set` → writeFileSync. `set` runs
 * on every cache MISS (recording the real response, including large LLM bodies).
 * fast-forward.js:81-114 calls has/get/set synchronously (no await), so under
 * concurrent blackbox load those synchronous writes stalled the Node event loop
 * for ~1s at a time — measured: /health latency 800-1200ms (it does no work),
 * the backend went unresponsive ("fetch failed" x155 across a full suite), and
 * agent background work timed out and flipped agents to FAILED (the pause-test
 * flake reproduced under REPLAY=1, never under REPLAY=0).
 *
 * This cache keeps the SAME synchronous has/get/set interface fast-forward
 * requires, but:
 *   - reads are served from an in-memory mirror (lazy-loaded + memoized on
 *     first access), so replaying a fixture never re-reads from disk;
 *   - writes update memory instantly and flush to disk ASYNCHRONOUSLY
 *     (fire-and-forget), so recording a response never blocks the event loop.
 *
 * Test-seeded fixture files (written directly to disk by e.g. auth.blackbox.ts
 * after startup) are still discovered via a cheap existsSync + a single
 * memoized read. The on-disk file scheme (sha256(key).json under
 * <cacheDir>/<namespace>) is unchanged, so existing seeding/tooling keeps
 * working byte-for-byte.
 */

import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, promises as fsPromises, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';

interface CacheEntry {
  key: string;
  value: unknown;
  timestamp: number;
  args?: unknown;
}

export class NonBlockingFileCache {
  private readonly dir: string;
  private readonly mem = new Map<string, unknown>();
  private readonly generations = new Map<string, number>();
  private readonly invalidated = new Set<string>();
  private readonly pendingWrites = new Map<string, Promise<void>>();
  private clearGeneration = 0;
  private clearBarrier: Promise<void> = Promise.resolve();
  private clearPending = false;

  constructor(options: { cacheDir: string; namespace: string }) {
    this.dir = join(options.cacheDir, options.namespace);
    mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Request keys embed the whole outbound body (LLM prompts can be tens of MB).
   * In-memory bookkeeping is keyed by this digest so the process never retains
   * a full key string per recorded call; the on-disk name is the same digest.
   */
  private idFor(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private bumpGeneration(id: string): number {
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.set(id, generation);
    return generation;
  }

  private isCurrent(
    id: string,
    value: unknown,
    generation: number,
    clearGeneration: number
  ): boolean {
    return (
      this.clearGeneration === clearGeneration &&
      this.generations.get(id) === generation &&
      this.mem.has(id) &&
      Object.is(this.mem.get(id), value)
    );
  }

  private queueKeyOperation(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.pendingWrites.get(id) ?? Promise.resolve();
    const clearBarrier = this.clearBarrier;
    const run = Promise.allSettled([previous, clearBarrier])
      .then(operation)
      .catch(() => {
        /* best-effort recording; a failed write just forces a real call later */
      });
    const tracked = run.finally(() => {
      if (this.pendingWrites.get(id) === tracked) this.pendingWrites.delete(id);
    });
    this.pendingWrites.set(id, tracked);
    return tracked;
  }

  /** True if the key is in memory or a fixture file exists on disk. */
  has(key: string | undefined): boolean {
    if (key === undefined) return false;
    const id = this.idFor(key);
    if (this.mem.has(id)) return true;
    if (this.invalidated.has(id) || this.clearPending) return false;
    return existsSync(this.pathFor(id));
  }

  /**
   * Serve from memory; on a cold hit read the fixture from disk ONCE (small
   * seeded/recorded files) and memoize so subsequent reads never touch disk.
   */
  get(key: string | undefined): unknown {
    if (key === undefined) return undefined;
    const id = this.idFor(key);
    if (this.mem.has(id)) return this.mem.get(id);
    if (this.invalidated.has(id) || this.clearPending) return undefined;
    const filePath = this.pathFor(id);
    if (!existsSync(filePath)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(filePath, 'utf8')) as CacheEntry;
      this.mem.set(id, entry.value);
      return entry.value;
    } catch {
      return undefined;
    }
  }

  /**
   * Update memory synchronously (so an immediate get() replays it), then flush
   * to disk asynchronously. fast-forward calls set() without awaiting, so the
   * async write never blocks the caller or the event loop.
   */
  set(key: string | undefined, value: unknown, args?: unknown): void {
    if (key === undefined) return;
    const id = this.idFor(key);
    const generation = this.bumpGeneration(id);
    const clearGeneration = this.clearGeneration;
    this.invalidated.delete(id);
    this.mem.set(id, value);
    setImmediate(() => {
      // A delete/clear or newer object value supersedes this deferred write.
      if (!this.isCurrent(id, value, generation, clearGeneration)) return;
      let data: string;
      try {
        const entry: CacheEntry = { key, value, timestamp: Date.now(), args };
        data = JSON.stringify(entry, null, 2);
      } catch {
        // Circular and bigint values remain memory-only instead of escaping the
        // deferred callback as an uncaught exception.
        return;
      }
      void this.queueKeyOperation(id, async () => {
        if (!this.isCurrent(id, value, generation, clearGeneration)) return;
        const filePath = this.pathFor(id);
        const tempPath = `${filePath}.${process.pid}.${generation}.${randomUUID()}.tmp`;
        try {
          await fsPromises.writeFile(tempPath, data, 'utf8');
          // The generation is checked after the awaited write and again after
          // the atomic publish. delete()/clear() can therefore overtake an old
          // write without allowing its stale fixture to survive.
          if (!this.isCurrent(id, value, generation, clearGeneration)) return;
          await fsPromises.rename(tempPath, filePath);
          if (!this.isCurrent(id, value, generation, clearGeneration)) {
            await fsPromises.unlink(filePath).catch(() => {});
          }
        } finally {
          await fsPromises.unlink(tempPath).catch(() => {});
        }
      });
    });
  }

  /** Remove a single entry from memory and disk; true if it existed. */
  delete(key: string | undefined): boolean {
    if (key === undefined) return false;
    const id = this.idFor(key);
    this.bumpGeneration(id);
    this.invalidated.add(id);
    const existed = this.mem.delete(id);
    const filePath = this.pathFor(id);
    let removedFromDisk = false;
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        removedFromDisk = true;
      }
    } catch {
      /* ignore */
    }
    void this.queueKeyOperation(id, async () => {
      await fsPromises.unlink(filePath).catch(() => {});
    });
    return existed || removedFromDisk;
  }

  /** Wipe the whole cache (memory now, fixture files asynchronously). */
  clear(): void {
    this.mem.clear();
    this.invalidated.clear();
    this.clearGeneration += 1;
    this.clearPending = true;
    const previousClear = this.clearBarrier;
    const pendingWrites = [...this.pendingWrites.values()];
    const cleanup = Promise.allSettled([previousClear, ...pendingWrites])
      .then(async () => {
        const files = await fsPromises.readdir(this.dir).catch(() => []);
        await Promise.allSettled(
          files
            .filter((file) => file.endsWith('.json'))
            .map((file) => fsPromises.unlink(join(this.dir, file)))
        );
      })
      .catch(() => {
        /* ignore */
      });
    const tracked = cleanup.finally(() => {
      if (this.clearBarrier === tracked) this.clearPending = false;
    });
    this.clearBarrier = tracked;
  }

  /** Test/teardown hook: wait until every already-scheduled disk mutation settles. */
  async flushPendingWrites(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (;;) {
      const clearBarrier = this.clearBarrier;
      const pendingWrites = [...this.pendingWrites.values()];
      await Promise.allSettled([clearBarrier, ...pendingWrites]);
      if (clearBarrier === this.clearBarrier && this.pendingWrites.size === 0) {
        return;
      }
    }
  }
}
