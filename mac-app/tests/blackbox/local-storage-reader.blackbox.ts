/**
 * local-storage-reader domain blackbox
 *
 * Surface under test:
 *   - main/services/localStorageReader.ts    (LocalStorageReader.readLocalStorage — Chrome LevelDB parse)
 *   - main/services/chromeProfileResolver.ts (resolveChromeProfileDir / resolveChromeProfilePath)
 *
 * Observable behavior exercised here:
 *   - resolveChromeProfileDir returns null when Chrome base missing or no Preferences files match.
 *   - resolveChromeProfileDir picks the profile with the most-recently modified Preferences file.
 *   - resolveChromeProfilePath returns null when no profile resolves OR when target doesn't exist,
 *     otherwise returns the joined absolute path inside the chosen profile.
 *   - LocalStorageReader.readLocalStorage returns empty shape ({entries:[], byOrigin:{}, hashes:{}, ...})
 *     when no Chrome profile is resolvable — with NO file copy and NO DB open attempted.
 *   - readLocalStorage returns empty shape when copying the Chrome DB throws (lock contention etc.),
 *     without crashing.
 *   - readLocalStorage copies the Chrome LevelDB directory to a temp path under app.getPath('temp'),
 *     opens it via ClassicLevel, iterates key/value buffers, decodes Chrome's key framing
 *     (`"_" + encoding + origin + NUL + encoding + key`) and value framing (`encoding + bytes`),
 *     groups entries by origin, filters out META: keys and chrome-extension:// origins,
 *     computes a deterministic truncated-sha256 hash per origin, closes the DB, and unlinks
 *     the temp copy — even on iterator errors.
 *   - Hashes are stable for the same key/value pairs regardless of insertion order
 *     (parity with computeOriginHash's sort-by-key).
 *   - Latin-1 (encoding 0x01) and UTF-16-LE (encoding 0x00) values both decode correctly.
 *   - DB open failure does not throw, leaves empty shape, and still attempts temp cleanup.
 *
 * Boundary capture: N/A — this domain makes zero outbound HTTP calls. The only system
 * boundaries are the filesystem (Chrome user data dir) and a local LevelDB handle. We stub
 * both via `vi.mock` and assert on the observable output shape + side effects (copy, open,
 * close, unlink). `fetchCaptures` is still asserted empty as a hard invariant.
 *
 * Scope deferrals (per batch prompt):
 *   - flake x5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// ── Mock electron.app (scoped, not via electron-stubs — we don't need the full stub set) ──
vi.mock('electron', () => ({
  app: {
    name: '',
    isPackaged: false,
    getPath: vi.fn((kind: string) => {
      if (kind === 'temp') return '/tmp/mac-app-test';
      if (kind === 'home') return '/tmp/mac-app-test';
      return '/tmp/mac-app-test';
    }),
    getName: vi.fn(() => 'rose-desktop-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    isReady: vi.fn(() => true),
  },
}));

// ── Mock the system boundaries LocalStorageReader reaches across ────────────

// `glob.sync` — drives profile discovery in chromeProfileResolver.
const globSync = vi.hoisted(() => vi.fn<(pattern: string) => string[]>(() => []));
vi.mock('glob', () => ({ glob: { sync: globSync }, sync: globSync }));

// `fs` — existsSync/statSync drive resolver; cpSync/rmSync drive reader temp handling.
const fsExistsSync = vi.hoisted(() => vi.fn<(p: string) => boolean>(() => false));
const fsStatSync = vi.hoisted(() =>
  vi.fn<(p: string) => { mtime: Date }>(() => ({ mtime: new Date(0) }))
);
const fsCpSync = vi.hoisted(() =>
  vi.fn<(src: string, dest: string, opts?: unknown) => void>(() => undefined)
);
const fsRmSync = vi.hoisted(() => vi.fn<(p: string, opts?: unknown) => void>(() => undefined));
vi.mock('fs', () => ({
  default: {
    existsSync: fsExistsSync,
    statSync: fsStatSync,
    cpSync: fsCpSync,
    rmSync: fsRmSync,
  },
  existsSync: fsExistsSync,
  statSync: fsStatSync,
  cpSync: fsCpSync,
  rmSync: fsRmSync,
}));

// `classic-level` — the LevelDB handle. Tests install per-case iterator fixtures.
type StubPair = [Buffer, Buffer];
let stubPairs: StubPair[] = [];
let iteratorError: Error | null = null;
const openMock = vi.hoisted(() => vi.fn<() => Promise<void>>(() => Promise.resolve()));
const closeMock = vi.hoisted(() => vi.fn<() => Promise<void>>(() => Promise.resolve()));
const dbCtor = vi.hoisted(() => vi.fn());
vi.mock('classic-level', () => {
  // Default ctor impl: exposes open/close/iterator.
  dbCtor.mockImplementation(() => ({
    open: openMock,
    close: closeMock,
    iterator: () => ({
      [Symbol.asyncIterator]: async function* () {
        if (iteratorError) throw iteratorError;
        for (const pair of stubPairs) {
          yield pair;
        }
      },
    }),
  }));
  return { __esModule: true, ClassicLevel: dbCtor };
});

// ── Helpers to build Chrome LevelDB key/value framing ──────────────────────────

/**
 * Build a Chrome localStorage LevelDB key buffer:
 *   "_" + encoding_byte(origin) + origin_bytes + NUL + encoding_byte(key) + key_bytes
 *
 * Note: parseKey in production scans for the FIRST null byte starting at index 1
 * of the post-"_" slice. That index-1 is the first byte of the origin — meaning the
 * origin encoding byte sits at index 0. If origin_encoding is 0x00, origin parsing
 * degenerates (empty string). Tests here use 0x01 (Latin-1) for origin by default
 * so ASCII origins parse cleanly, matching Chrome's actual on-disk framing for ASCII
 * host origins.
 */
function makeKey(
  origin: string,
  key: string,
  opts: { originEncoding?: number; keyEncoding?: number } = {}
): Buffer {
  const originEncoding = opts.originEncoding ?? 0x01; // Latin-1
  const keyEncoding = opts.keyEncoding ?? 0x01; // Latin-1
  const originBytes =
    originEncoding === 0x00 ? Buffer.from(origin, 'utf16le') : Buffer.from(origin, 'latin1');
  const keyBytes = keyEncoding === 0x00 ? Buffer.from(key, 'utf16le') : Buffer.from(key, 'latin1');
  return Buffer.concat([
    Buffer.from([0x5f]),
    Buffer.from([originEncoding]),
    originBytes,
    Buffer.from([0x00]),
    Buffer.from([keyEncoding]),
    keyBytes,
  ]);
}

/**
 * Build a Chrome localStorage LevelDB value buffer:
 *   encoding_byte + value_bytes
 */
function makeValue(value: string, encoding: number = 0x01): Buffer {
  const body = encoding === 0x00 ? Buffer.from(value, 'utf16le') : Buffer.from(value, 'latin1');
  return Buffer.concat([Buffer.from([encoding]), body]);
}

/**
 * Mirror of production `computeOriginHash` — sort-by-key, JSON stringify, sha256, first 16 hex.
 * Kept local so the test computes the expected hash independently instead of importing
 * a private helper.
 */
function expectedHash(entries: { key: string; value: string }[]): string {
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex').slice(0, 16);
}

/**
 * Default filesystem state: Chrome installed with a single "Default" profile that has
 * a `Local Storage/leveldb` directory. Tests override specific slots as needed.
 */
function installDefaultFs(): void {
  fsExistsSync.mockImplementation((p: string) => p.includes('Google/Chrome'));
  fsStatSync.mockImplementation(() => ({ mtime: new Date('2025-01-01T00:00:00Z') }));
  globSync.mockImplementation((pattern: string) => {
    if (pattern.includes('Google/Chrome')) {
      return ['/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Preferences'];
    }
    return [];
  });
}

/**
 * Wire up the full happy-path environment: resolvable Chrome profile + given leveldb pairs.
 */
function installReaderEnv(pairs: StubPair[]): void {
  installDefaultFs();
  stubPairs = pairs;
  iteratorError = null;
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('local-storage-reader blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    globSync.mockReset();
    fsExistsSync.mockReset();
    fsStatSync.mockReset();
    fsCpSync.mockReset();
    fsRmSync.mockReset();
    openMock.mockReset();
    openMock.mockResolvedValue(undefined);
    closeMock.mockReset();
    closeMock.mockResolvedValue(undefined);
    // Preserve the dbCtor implementation from the vi.mock factory so
    // `new ClassicLevel(...)` keeps returning an iterator-capable handle.
    dbCtor.mockClear();
    stubPairs = [];
    iteratorError = null;
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  // ── resolveChromeProfileDir / resolveChromeProfilePath ───────────────────

  describe('resolveChromeProfileDir', () => {
    it('returns null when the Chrome base directory does not exist', async () => {
      fsExistsSync.mockReturnValue(false);
      const { resolveChromeProfileDir } = await import('../../main/services/chromeProfileResolver');

      expect(resolveChromeProfileDir()).toBeNull();
      expect(globSync).not.toHaveBeenCalled();
    });

    it('returns null when Chrome base exists but no Preferences files match', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue([]);
      const { resolveChromeProfileDir } = await import('../../main/services/chromeProfileResolver');

      expect(resolveChromeProfileDir()).toBeNull();
    });

    it('picks the profile whose Preferences file has the most recent mtime', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue([
        '/tmp/Chrome/Default/Preferences',
        '/tmp/Chrome/Profile 1/Preferences',
        '/tmp/Chrome/Profile 2/Preferences',
      ]);
      fsStatSync.mockImplementation((p: string) => {
        if (p.includes('Profile 1')) return { mtime: new Date('2025-03-01T00:00:00Z') };
        if (p.includes('Profile 2')) return { mtime: new Date('2025-01-01T00:00:00Z') };
        return { mtime: new Date('2024-01-01T00:00:00Z') };
      });

      const { resolveChromeProfileDir } = await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfileDir()).toBe('/tmp/Chrome/Profile 1');
    });
  });

  describe('resolveChromeProfilePath', () => {
    it('returns null when no Chrome profile exists', async () => {
      fsExistsSync.mockReturnValue(false);
      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');

      expect(resolveChromeProfilePath('Local Storage', 'leveldb')).toBeNull();
    });

    it('returns null when the target segment inside the profile is missing', async () => {
      // Chrome base + Preferences exist, but the "Local Storage/leveldb" path does not.
      fsExistsSync.mockImplementation((p: string) => !p.endsWith('leveldb'));
      globSync.mockReturnValue(['/tmp/Chrome/Default/Preferences']);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01') });

      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfilePath('Local Storage', 'leveldb')).toBeNull();
    });

    it('returns the joined path when the target exists inside the chosen profile', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue(['/tmp/Chrome/Default/Preferences']);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01') });

      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfilePath('Local Storage', 'leveldb')).toBe(
        '/tmp/Chrome/Default/Local Storage/leveldb'
      );
    });
  });

  // ── LocalStorageReader.readLocalStorage — empty state ────────────────────

  describe('LocalStorageReader.readLocalStorage — empty state', () => {
    it('returns empty shape and does NOT copy/open DB when no Chrome profile resolves', async () => {
      fsExistsSync.mockReturnValue(false);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();

      expect(result).toEqual({
        entries: [],
        byOrigin: {},
        hashes: {},
        entryCount: 0,
        originCount: 0,
      });
      expect(fsCpSync).not.toHaveBeenCalled();
      expect(dbCtor).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns empty shape when the leveldb has no entries (DB still opened + closed + cleaned up)', async () => {
      installReaderEnv([]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();

      expect(result.entryCount).toBe(0);
      expect(result.originCount).toBe(0);
      expect(result.entries).toEqual([]);
      expect(result.byOrigin).toEqual({});
      expect(result.hashes).toEqual({});
      expect(fsCpSync).toHaveBeenCalledTimes(1);
      expect(dbCtor).toHaveBeenCalledTimes(1);
      expect(openMock).toHaveBeenCalledTimes(1);
      expect(closeMock).toHaveBeenCalledTimes(1);
      expect(fsRmSync).toHaveBeenCalledTimes(1);
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  // ── LocalStorageReader.readLocalStorage — happy path ─────────────────────

  describe('LocalStorageReader.readLocalStorage — happy path', () => {
    it('groups entries by origin, computes stable per-origin hashes, and reports counts', async () => {
      installReaderEnv([
        [makeKey('https://example.com', 'token'), makeValue('abc123')],
        [makeKey('https://example.com', 'user'), makeValue('alice')],
        [makeKey('https://other.com', 'sid'), makeValue('xyz')],
      ]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();

      expect(result.entryCount).toBe(3);
      expect(result.originCount).toBe(2);
      expect(Object.keys(result.byOrigin).sort()).toEqual([
        'https://example.com',
        'https://other.com',
      ]);
      expect(result.byOrigin['https://example.com']).toEqual(
        expect.arrayContaining([
          { key: 'token', value: 'abc123' },
          { key: 'user', value: 'alice' },
        ])
      );
      expect(result.byOrigin['https://other.com']).toEqual([{ key: 'sid', value: 'xyz' }]);

      // Hash determinism: recompute with the same inputs and compare.
      expect(result.hashes['https://example.com']).toBe(
        expectedHash([
          { key: 'token', value: 'abc123' },
          { key: 'user', value: 'alice' },
        ])
      );
      expect(result.hashes['https://other.com']).toBe(expectedHash([{ key: 'sid', value: 'xyz' }]));

      // Flat entries list preserves (origin, key, value) triples.
      expect(result.entries).toEqual(
        expect.arrayContaining([
          { origin: 'https://example.com', key: 'token', value: 'abc123' },
          { origin: 'https://example.com', key: 'user', value: 'alice' },
          { origin: 'https://other.com', key: 'sid', value: 'xyz' },
        ])
      );
    });

    it('hash is order-independent: same keys in different insertion orders yield identical hash', async () => {
      // First pass: insertion order A, B.
      installReaderEnv([
        [makeKey('https://example.com', 'a'), makeValue('1')],
        [makeKey('https://example.com', 'b'), makeValue('2')],
      ]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');
      const first = await LocalStorageReader.readLocalStorage();

      // Second pass: reversed insertion order B, A — hash must match.
      stubPairs = [
        [makeKey('https://example.com', 'b'), makeValue('2')],
        [makeKey('https://example.com', 'a'), makeValue('1')],
      ];
      const second = await LocalStorageReader.readLocalStorage();

      expect(first.hashes['https://example.com']).toBe(second.hashes['https://example.com']);
    });

    it('copies the leveldb directory to a temp path under app.getPath("temp") and cleans up', async () => {
      installReaderEnv([[makeKey('https://example.com', 'k'), makeValue('v')]]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      await LocalStorageReader.readLocalStorage();

      expect(fsCpSync).toHaveBeenCalledTimes(1);
      const [src, dest, opts] = fsCpSync.mock.calls[0];
      expect(src).toBe(
        '/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Local Storage/leveldb'
      );
      expect(dest).toContain('/tmp/mac-app-test');
      expect(dest).toContain('localStorage-copy-');
      expect(opts).toEqual({ recursive: true });

      expect(dbCtor).toHaveBeenCalledWith(dest, {
        keyEncoding: 'buffer',
        valueEncoding: 'buffer',
      });
      expect(closeMock).toHaveBeenCalledTimes(1);
      expect(fsRmSync).toHaveBeenCalledWith(dest, { recursive: true, force: true });
    });

    it('decodes UTF-16-LE encoded values (encoding byte 0x00)', async () => {
      installReaderEnv([[makeKey('https://example.com', 'utf16key'), makeValue('héllo', 0x00)]]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();
      expect(result.byOrigin['https://example.com']).toEqual([{ key: 'utf16key', value: 'héllo' }]);
    });

    it('decodes Latin-1 encoded values (encoding byte 0x01)', async () => {
      installReaderEnv([
        [makeKey('https://example.com', 'latinkey'), makeValue('plain-ascii', 0x01)],
      ]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();
      expect(result.byOrigin['https://example.com']).toEqual([
        { key: 'latinkey', value: 'plain-ascii' },
      ]);
    });
  });

  // ── LocalStorageReader.readLocalStorage — filter/skip behavior ───────────

  describe('LocalStorageReader.readLocalStorage — filter/skip', () => {
    it('filters out META: keys and keeps real entries', async () => {
      installReaderEnv([
        [makeKey('https://example.com', 'META:foo'), makeValue('internal')],
        [makeKey('https://example.com', 'realKey'), makeValue('realValue')],
      ]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();
      expect(result.entryCount).toBe(1);
      expect(result.byOrigin['https://example.com']).toEqual([
        { key: 'realKey', value: 'realValue' },
      ]);
    });

    it('filters out chrome-extension:// origins', async () => {
      installReaderEnv([
        [makeKey('chrome-extension://abcdef', 'extKey'), makeValue('extValue')],
        [makeKey('https://example.com', 'k'), makeValue('v')],
      ]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();
      expect(result.originCount).toBe(1);
      expect(Object.keys(result.byOrigin)).toEqual(['https://example.com']);
    });

    it('skips key buffers that do not start with the "_" prefix', async () => {
      const junkKey = Buffer.concat([
        Buffer.from([0x41]), // "A" — not 0x5f
        Buffer.from('garbage'),
      ]);
      installReaderEnv([
        [junkKey, makeValue('ignored')],
        [makeKey('https://example.com', 'good'), makeValue('keep')],
      ]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();
      expect(result.entryCount).toBe(1);
      expect(result.entries[0]).toMatchObject({
        origin: 'https://example.com',
        key: 'good',
        value: 'keep',
      });
    });

    it('skips empty value buffers (parseValue returns null) but keeps decodable siblings', async () => {
      installReaderEnv([
        [makeKey('https://example.com', 'empty'), Buffer.alloc(0)],
        [makeKey('https://example.com', 'good'), makeValue('kept')],
      ]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();
      expect(result.byOrigin['https://example.com']).toEqual([{ key: 'good', value: 'kept' }]);
    });
  });

  // ── LocalStorageReader.readLocalStorage — error states ───────────────────

  describe('LocalStorageReader.readLocalStorage — error state', () => {
    it('returns empty shape when copying the Chrome DB throws (lock contention, perms, etc.)', async () => {
      installDefaultFs();
      fsCpSync.mockImplementation(() => {
        throw new Error('EBUSY: resource busy or locked');
      });
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();

      expect(result).toEqual({
        entries: [],
        byOrigin: {},
        hashes: {},
        entryCount: 0,
        originCount: 0,
      });
      // DB must NOT be opened if the copy failed.
      expect(dbCtor).not.toHaveBeenCalled();
      expect(openMock).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('swallows iterator errors and still cleans up the temp copy', async () => {
      installReaderEnv([]);
      iteratorError = new Error('corrupt sst block');
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      const result = await LocalStorageReader.readLocalStorage();

      // The iterator threw before any entries were collected, so we expect an
      // empty result — not a rejection.
      expect(result.entryCount).toBe(0);
      expect(result.entries).toEqual([]);
      // Temp copy still removed via the finally block.
      expect(fsRmSync).toHaveBeenCalledTimes(1);
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  // ── Boundary invariant (HTTP) ────────────────────────────────────────────

  describe('boundary invariant (HTTP)', () => {
    it('makes zero outbound HTTP calls during readLocalStorage', async () => {
      installReaderEnv([[makeKey('https://example.com', 'k'), makeValue('v')]]);
      const { LocalStorageReader } = await import('../../main/services/localStorageReader');

      await LocalStorageReader.readLocalStorage();

      expect(fetchCaptures).toHaveLength(0);
    });
  });
});
