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

import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  promises as fsPromises,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'fs';
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

  constructor(options: { cacheDir: string; namespace: string }) {
    this.dir = join(options.cacheDir, options.namespace);
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex');
    return join(this.dir, `${hash}.json`);
  }

  /** True if the key is in memory or a fixture file exists on disk. */
  has(key: string | undefined): boolean {
    if (key === undefined) return false;
    if (this.mem.has(key)) return true;
    return existsSync(this.pathFor(key));
  }

  /**
   * Serve from memory; on a cold hit read the fixture from disk ONCE (small
   * seeded/recorded files) and memoize so subsequent reads never touch disk.
   */
  get(key: string | undefined): unknown {
    if (key === undefined) return undefined;
    if (this.mem.has(key)) return this.mem.get(key);
    const filePath = this.pathFor(key);
    if (!existsSync(filePath)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(filePath, 'utf8')) as CacheEntry;
      this.mem.set(key, entry.value);
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
    this.mem.set(key, value);
    const entry: CacheEntry = { key, value, timestamp: Date.now(), args };
    const data = JSON.stringify(entry, null, 2);
    void fsPromises.writeFile(this.pathFor(key), data, 'utf8').catch(() => {
      /* best-effort recording; a failed write just forces a real call later */
    });
  }

  /** Remove a single entry from memory and disk; true if it existed. */
  delete(key: string | undefined): boolean {
    if (key === undefined) return false;
    const existed = this.mem.delete(key);
    const filePath = this.pathFor(key);
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        return true;
      }
    } catch {
      /* ignore */
    }
    return existed;
  }

  /** Wipe the whole cache (memory now, fixture files asynchronously). */
  clear(): void {
    this.mem.clear();
    try {
      for (const f of readdirSync(this.dir)) {
        if (f.endsWith('.json')) {
          void fsPromises.unlink(join(this.dir, f)).catch(() => {});
        }
      }
    } catch {
      /* ignore */
    }
  }
}
