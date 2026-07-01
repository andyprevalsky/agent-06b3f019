/**
 * indexed-db-reader domain blackbox
 *
 * Surface under test:
 *   - main/services/indexedDBReader.ts
 *     IndexedDBReader.readIndexedDB(originFilter?) — spawns the bundled
 *     `scripts/read_indexeddb.py` Python helper (Chrome's LevelDB IndexedDB
 *     format needs a custom comparator), parses its stdout JSON array, and
 *     returns an `IndexedDBData` shape with a per-origin sha256(16) hash for
 *     cache invalidation.
 *
 * Observable behavior exercised here:
 *   - Successful Python run → results JSON parsed, every non-error origin
 *     receives a 16-hex-char sha256 hash, result preserves origin ordering.
 *   - Same `databases` shape → same hash regardless of process invocation
 *     (deterministic key for downstream cache).
 *   - Different `databases` shape → different hash (invariant for cache
 *     invalidation).
 *   - Python exits with code 1 and empty stderr → "no matching origins found",
 *     treated as a clean empty result (not an error).
 *   - Python exits with a non-zero code AND non-empty stderr → reported as
 *     error but still resolves to the empty shape (never rejects).
 *   - Python stdout returns a single-element `[{error: ...}]` → reported and
 *     resolves to empty shape.
 *   - Python stdout is not JSON → parse error handled, resolves to empty
 *     shape.
 *   - Python binary missing (spawn `error` event) → resolves to empty shape
 *     (never rejects).
 *   - No origin filter → script is invoked with a single arg (the script
 *     path); with an origin filter → two args (script path + filter).
 *   - Process cwd is always `app.getPath('home')` — a stable, per-user root.
 *
 * Boundary capture: N/A — this domain makes zero outbound HTTP calls. The
 *   only system boundaries are the Python subprocess, the filesystem (via
 *   `app.getPath('home')`), and `crypto` (pure JS). `fetchCaptures` is
 *   asserted empty as a hard invariant to guard against regression.
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks,
 *     broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import path from 'path';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// ── child_process.spawn shim ────────────────────────────────────────────────
// The SUT reads stdout/stderr `data` events and the process-level `close` /
// `error` events. Tests drive that lifecycle via the `SpawnDriver` callback.

interface SpawnedProc {
  command: string;
  args: readonly string[];
  cwd: string | undefined;
  emitter: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  stdout: EventEmitter;
  stderr: EventEmitter;
}

type SpawnDriver = (proc: SpawnedProc) => void;

const cp = vi.hoisted(() => ({
  spawned: [] as Array<{
    command: string;
    args: readonly string[];
    cwd: string | undefined;
    emitter: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    stdout: EventEmitter;
    stderr: EventEmitter;
  }>,
  driver: null as null | SpawnDriver,
}));

vi.mock('child_process', () => {
  const spawn = (
    command: string,
    args: readonly string[],
    options?: { cwd?: string }
  ): EventEmitter => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const emitter = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    emitter.stdout = stdout;
    emitter.stderr = stderr;
    const entry = { command, args, cwd: options?.cwd, emitter, stdout, stderr };
    cp.spawned.push(entry);
    // Defer so the SUT can attach its `data`/`close`/`error` listeners first.
    if (cp.driver) {
      const drv = cp.driver;
      queueMicrotask(() => drv(entry));
    }
    return emitter;
  };

  const mod = { spawn };
  return { ...mod, default: mod };
});

// ── Electron app.getPath stub ───────────────────────────────────────────────
const TEST_HOME = '/tmp/mac-app-test-home';
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => TEST_HOME),
    getAppPath: vi.fn(() => path.join(__dirname, '..', '..')),
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const EXPECTED_SCRIPT_SUFFIX = path.join('scripts', 'read_indexeddb.py');

const spawnedProcs = cp.spawned;

function setDriver(drv: SpawnDriver): void {
  cp.driver = drv;
}

function resetCp(): void {
  cp.spawned.length = 0;
  cp.driver = null;
}

/**
 * Compute the reference hash the same way the SUT does — 16-hex-char sha256
 * prefix of `JSON.stringify(origin.databases)`. Used by tests that assert on
 * the exact hash value rather than just shape.
 */
function referenceOriginHash(databases: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(databases)).digest('hex').slice(0, 16);
}

/** Drive the spawned process to success with the given JSON stdout payload. */
function driveSuccess(stdoutJson: unknown): SpawnDriver {
  return (proc) => {
    proc.stdout.emit('data', Buffer.from(JSON.stringify(stdoutJson)));
    proc.emitter.emit('close', 0);
  };
}

/** Drive the spawned process to non-zero exit. */
function driveExit(code: number, stderr = ''): SpawnDriver {
  return (proc) => {
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emitter.emit('close', code);
  };
}

/** Drive the spawned process to a raw-text stdout followed by close(0). */
function driveRawStdout(text: string): SpawnDriver {
  return (proc) => {
    proc.stdout.emit('data', Buffer.from(text));
    proc.emitter.emit('close', 0);
  };
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('indexed-db-reader blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    resetCp();
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  // ------------------------------------------------------------------
  // auth boundary
  // ------------------------------------------------------------------
  describe('auth boundary', () => {
    it('never shells out anywhere other than python3, never makes network calls', async () => {
      setDriver(driveSuccess([]));
      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');

      await IndexedDBReader.readIndexedDB();

      expect(spawnedProcs).toHaveLength(1);
      expect(spawnedProcs[0].command).toBe('python3');
      // cwd is always the user's home — never a system/root dir.
      expect(spawnedProcs[0].cwd).toBe(TEST_HOME);
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // happy path
  // ------------------------------------------------------------------
  describe('happy path', () => {
    it('parses the Python stdout JSON and returns origins + per-origin hashes', async () => {
      const origins = [
        {
          origin: 'https://www.amazon.com',
          databases: [
            {
              name: 'amazon-cart',
              objectStores: [
                {
                  name: 'items',
                  records: [
                    { key: 'asin-1', value: { qty: 2 } },
                    { key: 'asin-2', value: { qty: 1 } },
                  ],
                },
              ],
            },
          ],
        },
        {
          origin: 'https://mail.google.com',
          databases: [
            {
              name: 'gmail-threads',
              objectStores: [{ name: 'threads', records: [{ key: 1, value: { subject: 'hi' } }] }],
            },
          ],
        },
      ];
      setDriver(driveSuccess(origins));

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      const result = await IndexedDBReader.readIndexedDB();

      // Origins preserved verbatim and in order.
      expect(result.origins).toEqual(origins);

      // Hashes are 16-hex sha256 prefixes per non-error origin, keyed by
      // origin URL.
      expect(Object.keys(result.hashes).sort()).toEqual([
        'https://mail.google.com',
        'https://www.amazon.com',
      ]);
      for (const o of origins) {
        expect(result.hashes[o.origin]).toMatch(/^[a-f0-9]{16}$/);
        expect(result.hashes[o.origin]).toBe(referenceOriginHash(o.databases));
      }

      expect(fetchCaptures).toHaveLength(0);
    });

    it('invokes python3 with the bundled script path and no extra args when no filter given', async () => {
      setDriver(driveSuccess([]));

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      await IndexedDBReader.readIndexedDB();

      expect(spawnedProcs).toHaveLength(1);
      expect(spawnedProcs[0].command).toBe('python3');
      expect(spawnedProcs[0].args).toHaveLength(1);
      expect(spawnedProcs[0].args[0].endsWith(EXPECTED_SCRIPT_SUFFIX)).toBe(true);
    });

    it('passes the origin filter through as the second python3 arg', async () => {
      setDriver(driveSuccess([]));

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      await IndexedDBReader.readIndexedDB('amazon');

      expect(spawnedProcs).toHaveLength(1);
      expect(spawnedProcs[0].args).toHaveLength(2);
      expect(spawnedProcs[0].args[0].endsWith(EXPECTED_SCRIPT_SUFFIX)).toBe(true);
      expect(spawnedProcs[0].args[1]).toBe('amazon');
    });

    it('produces the same hash across two calls with identical databases (reproducibility)', async () => {
      const origin = {
        origin: 'https://reproducible.example.com',
        databases: [
          {
            name: 'db',
            objectStores: [{ name: 's', records: [{ key: 'k', value: 'v' }] }],
          },
        ],
      };

      setDriver(driveSuccess([origin]));
      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      const r1 = await IndexedDBReader.readIndexedDB();

      resetCp();
      setDriver(driveSuccess([origin]));
      const r2 = await IndexedDBReader.readIndexedDB();

      expect(r1.hashes[origin.origin]).toBe(r2.hashes[origin.origin]);
    });

    it('produces a different hash when the databases payload changes (invariant for cache invalidation)', async () => {
      const base = {
        origin: 'https://hash-sensitive.example.com',
        databases: [
          { name: 'db', objectStores: [{ name: 's', records: [{ key: 'a', value: 1 }] }] },
        ],
      };
      const mutated = {
        origin: 'https://hash-sensitive.example.com',
        databases: [
          { name: 'db', objectStores: [{ name: 's', records: [{ key: 'a', value: 2 }] }] },
        ],
      };

      setDriver(driveSuccess([base]));
      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      const h1 = (await IndexedDBReader.readIndexedDB()).hashes[base.origin];

      resetCp();
      setDriver(driveSuccess([mutated]));
      const h2 = (await IndexedDBReader.readIndexedDB()).hashes[mutated.origin];

      expect(h1).not.toBe(h2);
    });

    it('skips hashing for per-origin error entries but keeps them in the origins array', async () => {
      const good = {
        origin: 'https://good.example.com',
        databases: [{ name: 'db', objectStores: [] }],
      };
      const bad = {
        origin: 'https://bad.example.com',
        databases: [],
        error: 'leveldb corrupt',
      };

      setDriver(driveSuccess([good, bad]));
      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      const result = await IndexedDBReader.readIndexedDB();

      // Both origins are preserved in the output…
      expect(result.origins).toEqual([good, bad]);
      // …but only the non-error origin has a cache hash.
      expect(result.hashes).toEqual({
        [good.origin]: referenceOriginHash(good.databases),
      });
      expect(result.hashes[bad.origin]).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // empty state
  // ------------------------------------------------------------------
  describe('empty state', () => {
    it('returns { origins: [], hashes: {} } when python exits 1 with no stderr (no matching origins)', async () => {
      setDriver(driveExit(1, ''));

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      const result = await IndexedDBReader.readIndexedDB('nonexistent-origin-filter');

      expect(result).toEqual({ origins: [], hashes: {} });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns { origins: [], hashes: {} } when python stdout is an empty array', async () => {
      setDriver(driveSuccess([]));

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      const result = await IndexedDBReader.readIndexedDB();

      expect(result).toEqual({ origins: [], hashes: {} });
    });
  });

  // ------------------------------------------------------------------
  // error state
  // ------------------------------------------------------------------
  describe('error state', () => {
    it('returns the empty shape when python exits non-zero with stderr (real failure, not silently rethrown)', async () => {
      setDriver(
        driveExit(2, 'Traceback (most recent call last):\nImportError: ccl_chromium_reader')
      );

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      const result = await IndexedDBReader.readIndexedDB();

      expect(result).toEqual({ origins: [], hashes: {} });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns the empty shape when python emits a single-element [{error: ...}] payload', async () => {
      setDriver(
        driveSuccess([{ origin: '', databases: [], error: 'Chrome profile directory not found' }])
      );

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      const result = await IndexedDBReader.readIndexedDB();

      expect(result).toEqual({ origins: [], hashes: {} });
    });

    it('returns the empty shape when python stdout is not valid JSON', async () => {
      setDriver(driveRawStdout('this is not json at all'));

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      const result = await IndexedDBReader.readIndexedDB();

      expect(result).toEqual({ origins: [], hashes: {} });
    });

    it('returns the empty shape and never rejects when spawning python3 fails', async () => {
      // Skip the happy-path driver and emit an `error` event on the child
      // process instead — simulates python3 missing on $PATH.
      setDriver((proc) => {
        proc.emitter.emit('error', new Error('spawn python3 ENOENT'));
        // Node's child_process also emits close after an ENOENT; emit it to
        // mirror real behavior. The SUT's `close` handler sees code=1 with
        // empty stderr and would resolve anyway, but `error` handler fires
        // first.
        proc.emitter.emit('close', 1);
      });

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      const result = await IndexedDBReader.readIndexedDB();

      expect(result).toEqual({ origins: [], hashes: {} });
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // fetch-capture zero-HTTP invariant
  // ------------------------------------------------------------------
  describe('fetch-capture boundary invariant', () => {
    it('makes zero outbound HTTP calls during readIndexedDB (happy path)', async () => {
      setDriver(
        driveSuccess([
          {
            origin: 'https://invariant.example.com',
            databases: [{ name: 'db', objectStores: [] }],
          },
        ])
      );

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      await IndexedDBReader.readIndexedDB();

      expect(fetchCaptures).toHaveLength(0);
    });

    it('makes zero outbound HTTP calls even on python failure', async () => {
      setDriver(driveExit(2, 'boom'));

      const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
      await IndexedDBReader.readIndexedDB('amazon');

      expect(fetchCaptures).toHaveLength(0);
    });
  });
});
