/**
 * cookie-reader domain blackbox
 *
 * Surface under test:
 *   - main/services/cookieReader.ts       (CookieReader.readCookies: keychain → SQLite → decrypt v10 cookies)
 *   - main/services/chromeProfileResolver.ts (resolveChromeProfileDir / resolveChromeProfilePath)
 *   - shared/types/ipc.ts                 (CookieData shape — consumed, not tested directly)
 *
 * Observable behavior exercised here:
 *   - resolveChromeProfileDir returns null when Chrome base dir missing.
 *   - resolveChromeProfileDir returns null when no Preferences files exist.
 *   - resolveChromeProfileDir picks the profile with the most recently modified Preferences.
 *   - resolveChromeProfilePath returns null when target file missing; otherwise joined path.
 *   - CookieReader.readCookies returns [] when no profile resolved (no keychain/exec attempted).
 *   - CookieReader.readCookies copies the DB file, queries cookies, decrypts v10 values using the
 *     macOS Keychain-derived PBKDF2 key, strips the 32-byte random prefix + PKCS7 padding,
 *     maps rows to CookieData (0/1 → boolean), and cleans up the temp file.
 *   - Cookies with unrecoverable payloads (empty, bad padding, wrong prefix) are skipped, not thrown.
 *   - Plaintext ASCII values (non-v10 prefix) are returned as-is.
 *   - Keychain (`security ...`) errors propagate out as rejections (caller handles).
 *
 * Boundary capture: N/A — this domain makes zero outbound HTTP calls. The only system
 * boundaries are the macOS Keychain (via `security` CLI), the Chrome SQLite DB, and the
 * filesystem. We stub all three and assert on the DB row shape consumed + the CookieData
 * shape produced. `fetchCaptures` is still asserted empty as a hard invariant.
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// We do NOT import from ./electron-stubs in this suite — when both files'
// `vi.mock('better-sqlite3', ...)` declarations are parsed, vitest hoists the
// electron-stubs version even when `stubBetterSqlite3()` is never called,
// clobbering our per-case `dbCtor` spy. Instead, we inline just the electron
// stubs we need here (app.getPath, etc.).
vi.mock('electron', () => ({
  app: {
    name: '',
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/mac-app-test'),
    getName: vi.fn(() => 'rose-desktop-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
    isReady: vi.fn(() => true),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
  },
}));

// ── Mock the system boundaries CookieReader reaches across ──────────────────

// `glob.sync` — drives profile discovery in chromeProfileResolver.
const globSync = vi.hoisted(() => vi.fn<(pattern: string) => string[]>(() => []));
vi.mock('glob', () => ({ glob: { sync: globSync }, sync: globSync }));

// `fs` — existsSync/statSync drive resolver; mkdtempSync/copyFileSync/unlinkSync/rmdirSync drive reader.
const fsExistsSync = vi.hoisted(() => vi.fn<(p: string) => boolean>(() => false));
const fsStatSync = vi.hoisted(() =>
  vi.fn<(p: string) => { mtime: Date }>(() => ({ mtime: new Date(0) }))
);
const fsCopyFileSync = vi.hoisted(() =>
  vi.fn<(src: string, dest: string) => void>(() => undefined)
);
const fsUnlinkSync = vi.hoisted(() => vi.fn<(p: string) => void>(() => undefined));
const fsMkdtempSync = vi.hoisted(() =>
  vi.fn<(prefix: string) => string>((prefix) => `${prefix}mock`)
);
const fsRmdirSync = vi.hoisted(() => vi.fn<(p: string) => void>(() => undefined));
vi.mock('fs', () => ({
  default: {
    existsSync: fsExistsSync,
    statSync: fsStatSync,
    copyFileSync: fsCopyFileSync,
    unlinkSync: fsUnlinkSync,
    mkdtempSync: fsMkdtempSync,
    rmdirSync: fsRmdirSync,
  },
  existsSync: fsExistsSync,
  statSync: fsStatSync,
  copyFileSync: fsCopyFileSync,
  unlinkSync: fsUnlinkSync,
  mkdtempSync: fsMkdtempSync,
  rmdirSync: fsRmdirSync,
}));

// `child_process.exec` — used to call `security find-generic-password` for the Chrome key.
const execMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ default: { exec: execMock }, exec: execMock }));

// `better-sqlite3` — the cookies DB handle. Tests install per-case row fixtures.
interface StubRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  creation_utc: number;
  top_frame_site_key: string | null;
  last_access_utc: number;
  has_expires: number;
  is_persistent: number;
  priority: number;
  samesite: number;
  source_scheme: number;
  source_port: number;
  last_update_utc: number;
}
let stubRows: StubRow[] = [];
const dbCtor = vi.hoisted(() => vi.fn());
const prepareMock = vi.hoisted(() => vi.fn());
const dbClose = vi.hoisted(() => vi.fn());
vi.mock('better-sqlite3', () => {
  dbCtor.mockImplementation(() => ({
    prepare: prepareMock,
    close: dbClose,
    exec: vi.fn(),
    pragma: vi.fn(),
  }));
  return { __esModule: true, default: dbCtor };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

const CHROME_KEY_PASSWORD = 'test-keychain-password';
const CHROME_KEY = crypto.pbkdf2Sync(CHROME_KEY_PASSWORD, 'saltysalt', 1003, 16, 'sha1');
const CHROME_IV = Buffer.alloc(16, ' ');

/**
 * Build a Chrome-v10 encrypted cookie value that the real CookieReader.decryptValue
 * path will decrypt and strip of the 32-byte random prefix + PKCS7 padding.
 */
function encryptV10(value: string): Buffer {
  const prefix = crypto.randomBytes(32); // Chrome prepends 32 random bytes before the real value.
  const plaintext = Buffer.concat([prefix, Buffer.from(value, 'utf8')]);

  // Manual PKCS7 pad to 16-byte block (decryptValue disables auto-padding).
  const padLen = 16 - (plaintext.length % 16);
  const padded = Buffer.concat([plaintext, Buffer.alloc(padLen, padLen)]);

  const cipher = crypto.createCipheriv('aes-128-cbc', CHROME_KEY, CHROME_IV);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);

  return Buffer.concat([Buffer.from('v10', 'utf8'), ciphertext]);
}

function makeRow(overrides: Partial<StubRow> = {}): StubRow {
  return {
    host_key: '.example.com',
    name: 'session',
    encrypted_value: encryptV10('abc123'),
    path: '/',
    expires_utc: 13300000000000000,
    is_secure: 1,
    is_httponly: 1,
    creation_utc: 13300000000000000,
    top_frame_site_key: null,
    last_access_utc: 13300000000000000,
    has_expires: 1,
    is_persistent: 1,
    priority: 1,
    samesite: 0,
    source_scheme: 2,
    source_port: 443,
    last_update_utc: 13300000000000000,
    ...overrides,
  };
}

/**
 * Default filesystem state: Chrome installed with a single "Default" profile that contains
 * the Cookies file. Tests override specific slots as needed.
 */
function installDefaultFs(): void {
  fsExistsSync.mockImplementation((p: string) => {
    // Chrome base + Cookies file exist.
    return p.includes('Google/Chrome');
  });
  fsStatSync.mockImplementation(() => ({ mtime: new Date('2025-01-01T00:00:00Z') }));
  globSync.mockImplementation((pattern: string) => {
    if (pattern.includes('Google/Chrome')) {
      return ['/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Preferences'];
    }
    return [];
  });
}

function installKeychain(password: string = CHROME_KEY_PASSWORD): void {
  // child_process.exec is wrapped by util.promisify — the shim must respect the callback contract.
  execMock.mockImplementation(
    (
      _cmd: string,
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void
    ): void => {
      cb(null, { stdout: `${password}\n`, stderr: '' });
    }
  );
}

function installKeychainError(err: Error): void {
  execMock.mockImplementation((_cmd: string, cb: (e: Error | null) => void): void => {
    cb(err);
  });
}

function installCookieRows(rows: StubRow[]): void {
  stubRows = rows;
  prepareMock.mockImplementation(() => ({
    all: vi.fn(() => stubRows),
    get: vi.fn(() => undefined),
    run: vi.fn(() => ({ changes: 0 })),
  }));
}

/**
 * Wire up the full happy-path environment: resolvable Chrome profile, working
 * keychain lookup, and the given cookie rows. Used by every test that calls
 * `CookieReader.readCookies()` against a present Chrome install.
 */
function installReaderEnv(rows: StubRow[]): void {
  installDefaultFs();
  installKeychain();
  installCookieRows(rows);
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('cookie-reader blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    globSync.mockReset();
    fsExistsSync.mockReset();
    fsStatSync.mockReset();
    fsCopyFileSync.mockReset();
    fsUnlinkSync.mockReset();
    fsMkdtempSync.mockReset();
    fsMkdtempSync.mockImplementation((prefix: string) => `${prefix}mock`);
    fsRmdirSync.mockReset();
    execMock.mockReset();
    prepareMock.mockReset();
    // Preserve the dbCtor implementation (installed by the vi.mock factory) so
    // `new Database(...)` continues to return a handle wired to prepareMock —
    // only clear call history.
    dbCtor.mockClear();
    dbClose.mockClear();
    stubRows = [];
    // Capture any accidental outbound fetches so the boundary invariant is enforced.
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  describe('resolveChromeProfileDir', () => {
    it('returns null when Chrome base directory does not exist', async () => {
      fsExistsSync.mockReturnValue(false);
      const { resolveChromeProfileDir } = await import('../../main/services/chromeProfileResolver');

      expect(resolveChromeProfileDir()).toBeNull();
      expect(globSync).not.toHaveBeenCalled();
    });

    it('returns null when Chrome base exists but no profiles match', async () => {
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
    it('returns null when no profile exists', async () => {
      fsExistsSync.mockReturnValue(false);
      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');

      expect(resolveChromeProfilePath('Cookies')).toBeNull();
    });

    it('returns null when the target file inside the profile is missing', async () => {
      // Chrome base + Preferences exist, but the requested segment does not.
      fsExistsSync.mockImplementation((p: string) => !p.endsWith('Cookies'));
      globSync.mockReturnValue(['/tmp/Chrome/Default/Preferences']);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01') });

      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfilePath('Cookies')).toBeNull();
    });

    it('returns the joined path when the target exists inside the chosen profile', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue(['/tmp/Chrome/Default/Preferences']);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01') });

      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfilePath('Cookies')).toBe('/tmp/Chrome/Default/Cookies');
    });
  });

  describe('CookieReader.readCookies — empty state', () => {
    it('returns [] and makes no keychain/DB call when no Chrome profile is found', async () => {
      fsExistsSync.mockReturnValue(false);
      const { CookieReader } = await import('../../main/services/cookieReader');

      const result = await CookieReader.readCookies();

      expect(result).toEqual([]);
      expect(execMock).not.toHaveBeenCalled();
      expect(fsCopyFileSync).not.toHaveBeenCalled();
      expect(dbCtor).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns [] when the cookies DB has no rows', async () => {
      installReaderEnv([]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      const result = await CookieReader.readCookies();

      expect(result).toEqual([]);
      // DB was still opened + closed; temp file still cleaned up.
      expect(dbCtor).toHaveBeenCalledTimes(1);
      expect(dbClose).toHaveBeenCalledTimes(1);
      expect(fsUnlinkSync).toHaveBeenCalledTimes(1);
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  describe('CookieReader.readCookies — happy path', () => {
    it('decrypts v10 cookies, strips the 32-byte prefix, and returns CookieData rows', async () => {
      installReaderEnv([
        makeRow({ name: 'a', encrypted_value: encryptV10('valueA') }),
        makeRow({ name: 'b', encrypted_value: encryptV10('valueB'), host_key: '.other.com' }),
      ]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      const result = await CookieReader.readCookies();

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        host_key: '.example.com',
        name: 'a',
        value: 'valueA',
        is_secure: true, // 1 → true
        is_httponly: true,
        has_expires: true,
        is_persistent: true,
      });
      expect(result[1]).toMatchObject({
        host_key: '.other.com',
        name: 'b',
        value: 'valueB',
      });
    });

    it('coerces SQLite 0/1 ints to booleans for boolean-shaped fields', async () => {
      installReaderEnv([
        makeRow({
          encrypted_value: encryptV10('x'),
          is_secure: 0,
          is_httponly: 0,
          has_expires: 0,
          is_persistent: 0,
        }),
      ]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      const [cookie] = await CookieReader.readCookies();
      expect(cookie.is_secure).toBe(false);
      expect(cookie.is_httponly).toBe(false);
      expect(cookie.has_expires).toBe(false);
      expect(cookie.is_persistent).toBe(false);
    });

    it('coerces null top_frame_site_key to empty string', async () => {
      installReaderEnv([makeRow({ encrypted_value: encryptV10('y'), top_frame_site_key: null })]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      const [cookie] = await CookieReader.readCookies();
      expect(cookie.top_frame_site_key).toBe('');
    });

    it('copies the cookies file into a per-invocation temp dir before opening the DB and cleans up after', async () => {
      installReaderEnv([makeRow({ encrypted_value: encryptV10('v') })]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      await CookieReader.readCookies();

      expect(fsMkdtempSync).toHaveBeenCalledTimes(1);
      expect(fsCopyFileSync).toHaveBeenCalledTimes(1);
      const [, dest] = fsCopyFileSync.mock.calls[0];
      const [tempDir] = fsMkdtempSync.mock.calls[0];
      // The temp dir prefix is under app.getPath('temp') (stubbed to /tmp/mac-app-test).
      expect(tempDir).toContain('cookie-reader-');
      expect(dest).toContain('Cookies-copy.sqlite');
      expect(dbCtor).toHaveBeenCalledWith(dest, { readonly: true });
      expect(dbClose).toHaveBeenCalledTimes(1);
      expect(fsUnlinkSync).toHaveBeenCalledWith(dest);
      expect(fsRmdirSync).toHaveBeenCalled();
    });

    it('accepts plaintext ASCII values (non-v10 prefix) as-is', async () => {
      installReaderEnv([
        makeRow({ name: 'plain', encrypted_value: Buffer.from('plain-ascii-value', 'utf8') }),
      ]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      const result = await CookieReader.readCookies();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'plain', value: 'plain-ascii-value' });
    });
  });

  describe('CookieReader.readCookies — skip-and-continue', () => {
    it('skips cookies with empty encrypted_value but keeps decryptable siblings', async () => {
      installReaderEnv([
        makeRow({ name: 'empty', encrypted_value: Buffer.alloc(0) }),
        makeRow({ name: 'good', encrypted_value: encryptV10('kept') }),
      ]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      const result = await CookieReader.readCookies();
      expect(result.map((c) => c.name)).toEqual(['good']);
    });

    it('does not throw when decrypt-fails on invalid ciphertext shape (non-multiple of AES block)', async () => {
      // ciphertext length not a multiple of 16 → AES-CBC final() throws → decryptValue catches.
      const malformed = Buffer.concat([Buffer.from('v10'), Buffer.from('xxx')]);
      installReaderEnv([
        makeRow({ name: 'malformed', encrypted_value: malformed }),
        makeRow({ name: 'good', encrypted_value: encryptV10('kept') }),
      ]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      const result = await CookieReader.readCookies();
      expect(result.map((c) => c.name)).toEqual(['good']);
    });

    it('skips truncated v10 payloads (too short to decrypt) instead of crashing', async () => {
      installReaderEnv([
        // Starts with 'v10' but has no ciphertext — real CookieReader bails out cleanly.
        makeRow({ name: 'truncated', encrypted_value: Buffer.from('v10', 'utf8') }),
        makeRow({ name: 'good', encrypted_value: encryptV10('kept') }),
      ]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      const result = await CookieReader.readCookies();
      expect(result.map((c) => c.name)).toEqual(['good']);
    });
  });

  describe('CookieReader.readCookies — error state', () => {
    it('propagates keychain errors (security CLI failure) to the caller', async () => {
      installDefaultFs();
      installKeychainError(new Error('keychain denied'));
      // Install a row stub so the DB opens cleanly — readCookies currently
      // opens the DB BEFORE awaiting the keychain key, so we need to survive
      // that call and only fail at the key step.
      installCookieRows([]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      await expect(CookieReader.readCookies()).rejects.toThrow(/keychain denied/);
      // No cookies should be returned (the error short-circuits the query loop).
    });
  });

  describe('boundary invariant (HTTP)', () => {
    it('makes zero outbound HTTP calls during readCookies', async () => {
      installReaderEnv([makeRow({ encrypted_value: encryptV10('v') })]);
      const { CookieReader } = await import('../../main/services/cookieReader');

      await CookieReader.readCookies();

      expect(fetchCaptures).toHaveLength(0);
    });
  });
});
