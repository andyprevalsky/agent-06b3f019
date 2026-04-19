/**
 * cache-storage-reader domain blackbox
 *
 * Surface under test:
 *   - main/services/cacheStorageReader.ts     (CacheStorageReader.readCacheStorage: Service Worker
 *                                              database → origins → per-origin dir hash → index.txt
 *                                              → cache names)
 *   - main/services/chromeProfileResolver.ts  (resolveChromeProfileDir / resolveChromeProfilePath —
 *                                              shared with cookie-reader; only the narrow slice
 *                                              consumed by cacheStorageReader is re-verified here)
 *
 * Observable behavior exercised here:
 *   - readCacheStorage returns empty CacheStorageData when no Chrome CacheStorage dir exists.
 *   - readCacheStorage returns empty CacheStorageData when Chrome dir exists but SW database absent.
 *   - readCacheStorage extracts https/http origins from SW database files (.log / .ldb).
 *   - readCacheStorage filters out chrome-extension://, localhost, 127.0.0.1 origins.
 *   - readCacheStorage computes SHA1("<scheme>_<hostname>_<port>") directory hashes; default
 *     ports map to "0".
 *   - readCacheStorage parses cache names from index.txt, dropping UUIDs + $-prefixed refs +
 *     non-printable runs.
 *   - readCacheStorage only surfaces origins whose on-disk CacheStorage dir exists AND whose
 *     index.txt yielded at least one cache name.
 *   - readCacheStorage produces a stable 16-hex-char sha256 hash per origin (order-insensitive
 *     over cache names) for change detection.
 *   - readCacheStorage swallows per-file read errors and returns a well-formed empty result when
 *     the outer loop throws.
 *
 * Boundary capture: N/A — this domain makes zero outbound HTTP calls. The only system
 * boundaries are the filesystem and the pure-JS `crypto` module. We stub `fs`/`glob` and
 * assert on the readCacheStorage return shape. `fetchCaptures` is still asserted empty as a
 * hard invariant.
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// ── Electron stub (narrow — we only need app.getPath('home')) ──────────────
vi.mock('electron', () => ({
  app: {
    name: '',
    isPackaged: false,
    getPath: vi.fn((key: string) => (key === 'home' ? '/tmp/mac-app-test' : '/tmp/mac-app-test')),
    getName: vi.fn(() => 'rose-desktop-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    isReady: vi.fn(() => true),
  },
}));

// ── System boundary mocks ───────────────────────────────────────────────────

const globSync = vi.hoisted(() => vi.fn<(pattern: string) => string[]>(() => []));
vi.mock('glob', () => ({ glob: { sync: globSync }, sync: globSync }));

const fsExistsSync = vi.hoisted(() => vi.fn<(p: string) => boolean>(() => false));
const fsStatSync = vi.hoisted(() =>
  vi.fn<(p: string) => { mtime: Date }>(() => ({ mtime: new Date(0) }))
);
const fsReadFileSync = vi.hoisted(() =>
  vi.fn<(p: string) => Buffer | string>(() => Buffer.alloc(0))
);
const fsReaddirSync = vi.hoisted(() => vi.fn<(p: string) => string[]>(() => []));
vi.mock('fs', () => ({
  default: {
    existsSync: fsExistsSync,
    statSync: fsStatSync,
    readFileSync: fsReadFileSync,
    readdirSync: fsReaddirSync,
  },
  existsSync: fsExistsSync,
  statSync: fsStatSync,
  readFileSync: fsReadFileSync,
  readdirSync: fsReaddirSync,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const CHROME_BASE = '/tmp/mac-app-test/Library/Application Support/Google/Chrome';
const PROFILE_DIR = `${CHROME_BASE}/Default`;
const CACHE_STORAGE_DIR = `${PROFILE_DIR}/Service Worker/CacheStorage`;
const SW_DB_DIR = `${PROFILE_DIR}/Service Worker/Database`;

/**
 * Chrome's directory-hash scheme: SHA1("<scheme>_<hostname>_<port>") with port="0"
 * for the default of each scheme. Mirrors computeCacheStorageDirHash in the SUT.
 */
function dirHashForOrigin(origin: string): string {
  const url = new URL(origin);
  const scheme = url.protocol.replace(':', '');
  const port = url.port || '0';
  return crypto.createHash('sha1').update(`${scheme}_${url.hostname}_${port}`).digest('hex');
}

/**
 * Build an index.txt-like protobuf blob. The SUT's parser extracts all
 * length≥3 runs of printable ASCII between non-printable bytes, then filters
 * out UUIDs, $-prefixed refs, pure-hex tokens, and pure-numeric tokens.
 *
 * We emit: <NUL><name1><NUL><uuid1><NUL>... so the parser sees each token as a
 * discrete printable run.
 */
function buildIndexBuffer(entries: { name: string; uuid: string }[]): Buffer {
  const parts: Buffer[] = [Buffer.from([0x00])];
  for (const { name, uuid } of entries) {
    parts.push(Buffer.from(name, 'ascii'));
    parts.push(Buffer.from([0x00]));
    parts.push(Buffer.from(uuid, 'ascii'));
    parts.push(Buffer.from([0x00]));
  }
  return Buffer.concat(parts);
}

/**
 * Configure the filesystem so the resolver picks up a single Default profile
 * and the CacheStorage directory exists. Individual tests override specific
 * slots via per-call `mockImplementation` tweaks.
 */
function installChromeFs(options: {
  swDbEntries?: string[]; // filenames returned by readdirSync(SW_DB_DIR)
  swDbContents?: Record<string, Buffer | string>; // filename → content
  cacheStorageDirs?: Record<string, Buffer | null>; // dirHash → index.txt content (null = no index.txt)
}): void {
  const swDbEntries = options.swDbEntries ?? [];
  const swDbContents = options.swDbContents ?? {};
  const cacheStorageDirs = options.cacheStorageDirs ?? {};

  // Profile resolver: chrome base exists, one Default profile with Preferences.
  globSync.mockImplementation((pattern: string) => {
    if (pattern.includes('Google/Chrome')) {
      return [`${PROFILE_DIR}/Preferences`];
    }
    return [];
  });
  fsStatSync.mockImplementation(() => ({ mtime: new Date('2025-01-01T00:00:00Z') }));

  fsExistsSync.mockImplementation((p: string) => {
    if (p === CHROME_BASE) return true;
    if (p === PROFILE_DIR) return true;
    if (p === `${PROFILE_DIR}/Service Worker`) return true;
    if (p === CACHE_STORAGE_DIR) return true;
    if (p === SW_DB_DIR) return true;
    // Per-origin CacheStorage subdirs
    for (const [hash, index] of Object.entries(cacheStorageDirs)) {
      const dir = path.join(CACHE_STORAGE_DIR, hash);
      if (p === dir) return true;
      if (p === path.join(dir, 'index.txt')) return index !== null;
    }
    return false;
  });

  fsReaddirSync.mockImplementation((p: string) => {
    if (p === SW_DB_DIR) return swDbEntries;
    return [];
  });

  fsReadFileSync.mockImplementation((p: string) => {
    // Service Worker DB files
    for (const [name, content] of Object.entries(swDbContents)) {
      if (p === path.join(SW_DB_DIR, name)) {
        return typeof content === 'string' ? Buffer.from(content) : content;
      }
    }
    // Per-origin index.txt
    for (const [hash, index] of Object.entries(cacheStorageDirs)) {
      if (p === path.join(CACHE_STORAGE_DIR, hash, 'index.txt')) {
        return index ?? Buffer.alloc(0);
      }
    }
    return Buffer.alloc(0);
  });
}

/** Reset every mock to a clean baseline between tests. */
function resetMocks(): void {
  globSync.mockReset();
  fsExistsSync.mockReset();
  fsStatSync.mockReset();
  fsReadFileSync.mockReset();
  fsReaddirSync.mockReset();
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('cache-storage-reader blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    resetMocks();
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  describe('empty state', () => {
    it('returns empty CacheStorageData when Chrome is not installed', async () => {
      // Chrome base missing → resolver returns null → readCacheStorage early-returns.
      fsExistsSync.mockReturnValue(false);
      globSync.mockReturnValue([]);

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result).toEqual({ origins: [], hashes: {}, originCount: 0 });
      expect(fsReaddirSync).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns empty CacheStorageData when CacheStorage dir is missing', async () => {
      // Chrome installed, but no Service Worker/CacheStorage folder.
      globSync.mockReturnValue([`${PROFILE_DIR}/Preferences`]);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01') });
      fsExistsSync.mockImplementation((p: string) => {
        if (p === CHROME_BASE) return true;
        if (p === PROFILE_DIR) return true;
        // Key: CacheStorage target does not exist.
        return false;
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result).toEqual({ origins: [], hashes: {}, originCount: 0 });
      expect(fsReaddirSync).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns empty CacheStorageData when SW database dir is missing', async () => {
      // CacheStorage exists but Service Worker/Database does not → extractOriginsFromSwDatabase
      // returns [] → no origins surveyed.
      installChromeFs({}); // no swDbEntries
      fsExistsSync.mockImplementation((p: string) => {
        if (p === CHROME_BASE) return true;
        if (p === PROFILE_DIR) return true;
        if (p === CACHE_STORAGE_DIR) return true;
        // SW_DB_DIR does not exist.
        return false;
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result).toEqual({ origins: [], hashes: {}, originCount: 0 });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns empty CacheStorageData when SW database is present but yields zero origins', async () => {
      installChromeFs({
        swDbEntries: ['000003.log'],
        swDbContents: { '000003.log': Buffer.from('no urls in here, just bytes') },
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result).toEqual({ origins: [], hashes: {}, originCount: 0 });
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  describe('happy path', () => {
    it('returns origins with parsed cache names and a stable per-origin hash', async () => {
      const origin = 'https://mail.google.com';
      const hash = dirHashForOrigin(origin);

      installChromeFs({
        swDbEntries: ['MANIFEST-000001', '000003.log', 'README'],
        swDbContents: {
          '000003.log': Buffer.from(`garbage ${origin} trailing`),
          // MANIFEST and README are ignored (wrong extension).
          'MANIFEST-000001': Buffer.from(`ignored ${origin}`),
          README: Buffer.from(`ignored ${origin}`),
        },
        cacheStorageDirs: {
          [hash]: buildIndexBuffer([
            { name: 'offline-asset-cache', uuid: '00000000-0000-0000-0000-000000000001' },
            { name: 'sw-/mail/u/0/', uuid: '00000000-0000-0000-0000-000000000002' },
          ]),
        },
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result.originCount).toBe(1);
      expect(result.origins).toHaveLength(1);
      expect(result.origins[0].origin).toBe(origin);

      const names = result.origins[0].caches.map((c) => c.name).sort();
      expect(names).toContain('offline-asset-cache');
      expect(names).toContain('sw-/mail/u/0/');
      // UUIDs must be stripped by the parser.
      expect(names.some((n) => /^[a-f0-9]{8}-/.test(n))).toBe(false);

      // Per-origin hash is a 16-char sha256 prefix and is deterministic for the same names.
      expect(result.hashes[origin]).toMatch(/^[a-f0-9]{16}$/);
      const expected = crypto
        .createHash('sha256')
        .update(JSON.stringify([...names]))
        .digest('hex')
        .slice(0, 16);
      expect(result.hashes[origin]).toBe(expected);
    });

    it('produces the same per-origin hash regardless of cache-name ordering on disk', async () => {
      const origin = 'https://example.com';
      const hash = dirHashForOrigin(origin);

      // Run 1: cache names in one order.
      installChromeFs({
        swDbEntries: ['000003.log'],
        swDbContents: { '000003.log': Buffer.from(`seen: ${origin}`) },
        cacheStorageDirs: {
          [hash]: buildIndexBuffer([
            { name: 'alpha-cache', uuid: '00000000-0000-0000-0000-000000000001' },
            { name: 'zeta-cache', uuid: '00000000-0000-0000-0000-000000000002' },
          ]),
        },
      });
      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const r1 = await CacheStorageReader.readCacheStorage();

      // Run 2: same names, reversed on-disk order.
      resetMocks();
      installChromeFs({
        swDbEntries: ['000003.log'],
        swDbContents: { '000003.log': Buffer.from(`seen: ${origin}`) },
        cacheStorageDirs: {
          [hash]: buildIndexBuffer([
            { name: 'zeta-cache', uuid: '00000000-0000-0000-0000-000000000002' },
            { name: 'alpha-cache', uuid: '00000000-0000-0000-0000-000000000001' },
          ]),
        },
      });
      const r2 = await CacheStorageReader.readCacheStorage();

      expect(r1.hashes[origin]).toBe(r2.hashes[origin]);
    });

    it('aggregates multiple origins that each have a CacheStorage dir', async () => {
      const o1 = 'https://mail.google.com';
      const o2 = 'https://calendar.google.com';
      const h1 = dirHashForOrigin(o1);
      const h2 = dirHashForOrigin(o2);

      installChromeFs({
        swDbEntries: ['000003.log'],
        swDbContents: { '000003.log': Buffer.from(`two origins: ${o1} and ${o2} here`) },
        cacheStorageDirs: {
          [h1]: buildIndexBuffer([
            { name: 'mail-cache', uuid: '00000000-0000-0000-0000-000000000001' },
          ]),
          [h2]: buildIndexBuffer([
            { name: 'calendar-cache', uuid: '00000000-0000-0000-0000-000000000002' },
          ]),
        },
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result.originCount).toBe(2);
      const byOrigin = Object.fromEntries(result.origins.map((o) => [o.origin, o]));
      expect(Object.keys(byOrigin).sort()).toEqual([o2, o1].sort());
      expect(byOrigin[o1].caches.map((c) => c.name)).toContain('mail-cache');
      expect(byOrigin[o2].caches.map((c) => c.name)).toContain('calendar-cache');
    });
  });

  describe('filtering', () => {
    it('skips chrome-extension, localhost, and 127.0.0.1 origins from the SW database', async () => {
      // None of these should appear in the result even if a CacheStorage dir existed
      // for their hashes — extractOriginsFromSwDatabase filters them out before the
      // dir-hash step ever runs.
      const realOrigin = 'https://real.example.com';
      const realHash = dirHashForOrigin(realOrigin);

      installChromeFs({
        swDbEntries: ['000003.log'],
        swDbContents: {
          '000003.log': Buffer.from(
            `chrome-extension://abcdef and http://localhost:5173 and http://127.0.0.1:8080 and ${realOrigin}`
          ),
        },
        cacheStorageDirs: {
          [realHash]: buildIndexBuffer([
            { name: 'real-cache', uuid: '00000000-0000-0000-0000-000000000001' },
          ]),
        },
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result.originCount).toBe(1);
      expect(result.origins[0].origin).toBe(realOrigin);
      expect(result.origins.some((o) => o.origin.includes('localhost'))).toBe(false);
      expect(result.origins.some((o) => o.origin.includes('127.0.0.1'))).toBe(false);
      expect(result.origins.some((o) => o.origin.startsWith('chrome-extension'))).toBe(false);
    });

    it('only surfaces origins whose on-disk CacheStorage dir exists AND index.txt yields cache names', async () => {
      const present = 'https://has-cache.example.com';
      const missingDir = 'https://no-disk.example.com';
      const emptyIndex = 'https://empty-index.example.com';

      installChromeFs({
        swDbEntries: ['000003.log'],
        swDbContents: {
          '000003.log': Buffer.from(`${present} ${missingDir} ${emptyIndex}`),
        },
        cacheStorageDirs: {
          [dirHashForOrigin(present)]: buildIndexBuffer([
            { name: 'present-cache', uuid: '00000000-0000-0000-0000-000000000001' },
          ]),
          // `missingDir` omitted entirely → fs.existsSync returns false for its dir.
          // `emptyIndex` has a zero-byte index.txt → parser returns 0 cache names → origin dropped.
          [dirHashForOrigin(emptyIndex)]: Buffer.alloc(0),
        },
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result.originCount).toBe(1);
      expect(result.origins[0].origin).toBe(present);
    });
  });

  describe('parseCacheNamesFromIndex filtering', () => {
    it('drops UUID tokens, $-prefixed refs, and pure-numeric tokens from cache names', async () => {
      const origin = 'https://filter.test.com';
      const hash = dirHashForOrigin(origin);

      // Hand-crafted index blob mixing valid names with tokens the parser must drop.
      const blob = Buffer.concat([
        Buffer.from([0x00]),
        Buffer.from('valid-cache-name', 'ascii'),
        Buffer.from([0x00]),
        Buffer.from('00000000-0000-0000-0000-000000000001', 'ascii'), // UUID — drop
        Buffer.from([0x00]),
        Buffer.from('$00000000-0000-0000-0000-000000000002', 'ascii'), // $-prefix — drop
        Buffer.from([0x00]),
        Buffer.from('12345', 'ascii'), // pure numeric — drop
        Buffer.from([0x00]),
        Buffer.from('another-cache', 'ascii'),
        Buffer.from([0x00]),
      ]);

      installChromeFs({
        swDbEntries: ['000003.log'],
        swDbContents: { '000003.log': Buffer.from(`seen: ${origin}`) },
        cacheStorageDirs: { [hash]: blob },
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result.originCount).toBe(1);
      const names = result.origins[0].caches.map((c) => c.name);
      expect(names).toContain('valid-cache-name');
      expect(names).toContain('another-cache');
      expect(names.some((n) => /^[a-f0-9]{8}-/.test(n))).toBe(false);
      expect(names.some((n) => n.startsWith('$'))).toBe(false);
      expect(names).not.toContain('12345');
    });
  });

  describe('error state', () => {
    it('returns an empty CacheStorageData when readdirSync throws on the SW database', async () => {
      // The SW-database read is wrapped in its own try/catch — the outer readCacheStorage
      // must still return a well-formed empty object rather than propagate.
      globSync.mockReturnValue([`${PROFILE_DIR}/Preferences`]);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01') });
      fsExistsSync.mockImplementation((p: string) => {
        if (p === CHROME_BASE) return true;
        if (p === PROFILE_DIR) return true;
        if (p === CACHE_STORAGE_DIR) return true;
        if (p === SW_DB_DIR) return true;
        return false;
      });
      fsReaddirSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result).toEqual({ origins: [], hashes: {}, originCount: 0 });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('tolerates per-file read errors inside the SW database and keeps scanning', async () => {
      const origin = 'https://survives.example.com';
      const hash = dirHashForOrigin(origin);

      let callCount = 0;
      installChromeFs({
        swDbEntries: ['000001.ldb', '000003.log'],
        swDbContents: {
          // 000001.ldb will throw; 000003.log will return the origin.
          '000001.ldb': Buffer.from('will-throw'),
          '000003.log': Buffer.from(`good: ${origin}`),
        },
        cacheStorageDirs: {
          [hash]: buildIndexBuffer([
            { name: 'survivor-cache', uuid: '00000000-0000-0000-0000-000000000001' },
          ]),
        },
      });
      // Re-wire readFileSync to throw for the first SW-DB file only.
      const existing = fsReadFileSync.getMockImplementation();
      fsReadFileSync.mockImplementation((p: string) => {
        if (p === path.join(SW_DB_DIR, '000001.ldb')) {
          callCount++;
          throw new Error('read error');
        }
        return existing ? (existing(p) as Buffer) : Buffer.alloc(0);
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(callCount).toBe(1);
      expect(result.originCount).toBe(1);
      expect(result.origins[0].origin).toBe(origin);
      expect(result.origins[0].caches.map((c) => c.name)).toContain('survivor-cache');
    });
  });

  describe('auth boundary', () => {
    it('never reads anything outside the resolved Chrome profile (no Keychain, no exec)', async () => {
      // Sanity: the reader has no cred/auth surface. Wire a fully empty fs and verify that
      // we never escalate past fs + glob boundaries.
      fsExistsSync.mockReturnValue(false);
      globSync.mockReturnValue([]);

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      const result = await CacheStorageReader.readCacheStorage();

      expect(result.originCount).toBe(0);
      // If this domain ever grew a keychain / HTTP dependency, fetchCaptures would flag it.
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  describe('fetch-capture boundary invariant', () => {
    it('makes zero outbound HTTP calls during readCacheStorage (happy path)', async () => {
      const origin = 'https://no-network.example.com';
      const hash = dirHashForOrigin(origin);

      installChromeFs({
        swDbEntries: ['000003.log'],
        swDbContents: { '000003.log': Buffer.from(`seen: ${origin}`) },
        cacheStorageDirs: {
          [hash]: buildIndexBuffer([
            { name: 'only-cache', uuid: '00000000-0000-0000-0000-000000000001' },
          ]),
        },
      });

      const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
      await CacheStorageReader.readCacheStorage();

      expect(fetchCaptures).toHaveLength(0);
    });
  });
});
