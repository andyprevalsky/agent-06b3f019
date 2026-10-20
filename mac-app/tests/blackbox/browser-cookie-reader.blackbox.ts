/**
 * browser-cookie-reader domain blackbox
 *
 * Surface under test:
 *   - main/services/browserCookieReader.ts (BrowserCookieReader — multi-browser)
 *   - shared/types/ipc.ts                  (CookieData / BrowserType — consumed, not tested directly)
 *
 * Public entrypoints:
 *   - BrowserCookieReader.getInstalledBrowsers()
 *   - BrowserCookieReader.getBrowserConfig(browserType)
 *   - BrowserCookieReader.readCookies(browserType, config?)
 *
 * Observable behavior exercised here:
 *   - getInstalledBrowsers filters the static BROWSERS map to only those whose
 *     cookiePathPattern resolves via glob/fs.existsSync — returns shape
 *     { type, name, isInstalled, needsManualPassword, resolvedCookiePath, ... }.
 *   - For wildcard patterns, resolveCookiePath picks the most-recently-modified match.
 *   - getBrowserConfig returns the static config for a known type or null for unknown.
 *   - readCookies('chrome'): runs `security find-generic-password` with the Chrome keychain
 *     account, derives PBKDF2 key, copies DB to temp, decrypts v10 rows, strips 32-byte prefix
 *     + PKCS7 padding, maps to CookieData (0/1 → boolean), and cleans up temp file.
 *   - readCookies('atlas'): REQUIRES config.keychainPassword (no `security` call); throws
 *     a helpful error if missing.
 *   - readCookies returns [] when the browser's cookies file is missing (no keychain/DB touched).
 *   - readCookies throws "Unknown browser type" for an unrecognized browser string.
 *   - Rows with undecryptable payloads (v10 malformed, empty) are skipped, not thrown.
 *   - Wrong-password detection: if >10 rows are present and <10% decrypt, throws a
 *     "keychain password may be incorrect" error (covers Atlas wrong-password UX).
 *   - Keychain CLI errors bubble up as a helpful "Failed to get ... encryption key" error.
 *
 * Boundary capture: N/A — this domain makes zero outbound HTTP calls. System boundaries
 *   are macOS Keychain (`security` CLI), SQLite (better-sqlite3), and the filesystem.
 *   All three are stubbed. `fetchCaptures` is still asserted empty as an invariant.
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// ── Electron stub (inline — matches cookie-reader.blackbox.ts pattern) ──────
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

// ── Mock the system boundaries BrowserCookieReader reaches across ──────────

const globSync = vi.hoisted(() => vi.fn<(pattern: string) => string[]>(() => []));
vi.mock('glob', () => ({ glob: { sync: globSync }, sync: globSync }));

const fsExistsSync = vi.hoisted(() => vi.fn<(p: string) => boolean>(() => false));
const fsStatSync = vi.hoisted(() =>
  vi.fn<(p: string) => { mtime: Date }>(() => ({ mtime: new Date(0) }))
);
const fsCopyFileSync = vi.hoisted(() =>
  vi.fn<(src: string, dest: string) => void>(() => undefined)
);
const fsUnlinkSync = vi.hoisted(() => vi.fn<(p: string) => void>(() => undefined));
const fsReadFileSync = vi.hoisted(() => vi.fn<(p: string) => Buffer>(() => Buffer.alloc(0)));
vi.mock('fs', () => ({
  default: {
    existsSync: fsExistsSync,
    statSync: fsStatSync,
    copyFileSync: fsCopyFileSync,
    unlinkSync: fsUnlinkSync,
    readFileSync: fsReadFileSync,
  },
  existsSync: fsExistsSync,
  statSync: fsStatSync,
  copyFileSync: fsCopyFileSync,
  unlinkSync: fsUnlinkSync,
  readFileSync: fsReadFileSync,
}));

const execMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ default: { exec: execMock }, exec: execMock }));

// ── better-sqlite3 stub ─────────────────────────────────────────────────────

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
const ATLAS_KEY_PASSWORD = 'test-atlas-manual-password';
const CHROME_IV = Buffer.alloc(16, ' ');

/**
 * Build a Chrome-v10 encrypted cookie value that the real decryptValue path will
 * decrypt and strip of the 32-byte random prefix + PKCS7 padding.
 */
function encryptV10(value: string, password: string = CHROME_KEY_PASSWORD): Buffer {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const prefix = crypto.randomBytes(32); // Chrome prepends 32 random bytes.
  const plaintext = Buffer.concat([prefix, Buffer.from(value, 'utf8')]);
  const padLen = 16 - (plaintext.length % 16);
  const padded = Buffer.concat([plaintext, Buffer.alloc(padLen, padLen)]);

  const cipher = crypto.createCipheriv('aes-128-cbc', key, CHROME_IV);
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

function installKeychain(password: string = CHROME_KEY_PASSWORD): void {
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
 * Wire up a present Chrome install — the production cookiePathPattern contains a
 * `*` (profile dir wildcard), so resolution goes through glob.sync + statSync.
 */
function installChromeFs(): void {
  fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });
  globSync.mockImplementation((pattern: string) =>
    pattern.includes('Google/Chrome')
      ? ['/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Cookies']
      : []
  );
  fsExistsSync.mockReturnValue(false);
}

/**
 * Wire up a present Atlas install — wildcard pattern with one matching path.
 */
function installAtlasFs(matches: string[] = ['/tmp/mac-app-test/atlas-user/Cookies']): void {
  fsExistsSync.mockReturnValue(false); // irrelevant for wildcard-path branch
  fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });
  globSync.mockImplementation((pattern: string) =>
    pattern.includes('com.openai.atlas') ? matches : []
  );
}

function buildSafariBinaryCookies(
  cookies: Array<{
    host: string;
    name: string;
    path: string;
    value: string;
    flags?: number;
    expiresAt?: number;
    createdAt?: number;
  }>
): Buffer {
  const cookieBuffers = cookies.map((cookie) => {
    const headerSize = 56;
    const strings = [
      Buffer.from(`${cookie.host}\0`, 'utf8'),
      Buffer.from(`${cookie.name}\0`, 'utf8'),
      Buffer.from(`${cookie.path}\0`, 'utf8'),
      Buffer.from(`${cookie.value}\0`, 'utf8'),
    ];
    const hostOffset = headerSize;
    const nameOffset = hostOffset + strings[0].length;
    const pathOffset = nameOffset + strings[1].length;
    const valueOffset = pathOffset + strings[2].length;
    const size = valueOffset + strings[3].length;
    const buf = Buffer.alloc(size);
    buf.writeUInt32LE(size, 0);
    buf.writeUInt32LE(cookie.flags ?? 0, 8);
    buf.writeUInt32LE(hostOffset, 16);
    buf.writeUInt32LE(nameOffset, 20);
    buf.writeUInt32LE(pathOffset, 24);
    buf.writeUInt32LE(valueOffset, 28);
    buf.writeDoubleLE(cookie.expiresAt ?? 8000, 40);
    buf.writeDoubleLE(cookie.createdAt ?? 7000, 48);
    Buffer.concat(strings).copy(buf, headerSize);
    return buf;
  });

  const pageHeaderSize = 8 + cookieBuffers.length * 4;
  let nextCookieOffset = pageHeaderSize;
  const cookieOffsets = cookieBuffers.map((buf) => {
    const offset = nextCookieOffset;
    nextCookieOffset += buf.length;
    return offset;
  });
  const page = Buffer.alloc(nextCookieOffset);
  page.writeUInt32LE(0x00000100, 0);
  page.writeUInt32LE(cookieBuffers.length, 4);
  cookieOffsets.forEach((offset, index) => page.writeUInt32LE(offset, 8 + index * 4));
  cookieBuffers.forEach((buf, index) => buf.copy(page, cookieOffsets[index]));

  const file = Buffer.alloc(12);
  file.write('cook', 0, 'ascii');
  file.writeUInt32BE(1, 4);
  file.writeUInt32BE(page.length, 8);
  return Buffer.concat([file, page]);
}

function installSafariFs(buffer = buildSafariBinaryCookies([])): void {
  globSync.mockReturnValue([]);
  fsExistsSync.mockImplementation((pattern: string) => pattern.includes('Cookies.binarycookies'));
  fsReadFileSync.mockReturnValue(buffer);
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('browser-cookie-reader blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    globSync.mockReset();
    fsExistsSync.mockReset();
    fsStatSync.mockReset();
    fsCopyFileSync.mockReset();
    fsUnlinkSync.mockReset();
    fsReadFileSync.mockReset();
    execMock.mockReset();
    prepareMock.mockReset();
    dbCtor.mockClear();
    dbClose.mockClear();
    stubRows = [];
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  describe('getBrowserConfig', () => {
    it('returns config for a known browser type', async () => {
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');
      const config = BrowserCookieReader.getBrowserConfig('chrome');

      expect(config).not.toBeNull();
      expect(config).toMatchObject({
        type: 'chrome',
        name: 'Chrome',
        keychainAccount: 'Chrome',
        needsManualPassword: false,
        cookieStore: 'sqlite',
      });
    });

    it('marks Atlas as needsManualPassword=true (Data Protection keychain)', async () => {
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');
      const config = BrowserCookieReader.getBrowserConfig('atlas');

      expect(config).not.toBeNull();
      expect(config?.needsManualPassword).toBe(true);
      expect(config?.keychainEntry).toBe('ChatGPT Safe Storage');
    });

    it('returns Safari as a binary cookie store browser', async () => {
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');
      const config = BrowserCookieReader.getBrowserConfig('safari');

      expect(config).toMatchObject({
        type: 'safari',
        name: 'Safari',
        needsManualPassword: false,
        cookieStore: 'safariBinary',
      });
      expect(config?.cookiePathPattern).toContain('Cookies.binarycookies');
    });

    it('returns null for an unknown browser type', async () => {
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');
      // Cast to bypass the typed union — public API shape allows unknown at runtime.
      const config = BrowserCookieReader.getBrowserConfig(
        'firefox' as unknown as Parameters<typeof BrowserCookieReader.getBrowserConfig>[0]
      );

      expect(config).toBeNull();
    });
  });

  describe('getInstalledBrowsers', () => {
    it('returns [] when no browser cookie paths resolve', async () => {
      fsExistsSync.mockReturnValue(false);
      globSync.mockReturnValue([]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      expect(BrowserCookieReader.getInstalledBrowsers()).toEqual([]);
    });

    it('returns only browsers whose cookie file resolves, with resolvedCookiePath set', async () => {
      // Both Chrome and Atlas use wildcard patterns → both go through glob.sync.
      fsExistsSync.mockReturnValue(false);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });
      globSync.mockImplementation((pattern: string) => {
        if (pattern.includes('Google/Chrome'))
          return ['/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Cookies'];
        if (pattern.includes('com.openai.atlas'))
          return [
            '/tmp/mac-app-test/Library/Application Support/com.openai.atlas/browser-data/host/user-1/Cookies',
          ];
        return [];
      });

      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');
      const installed = BrowserCookieReader.getInstalledBrowsers();

      const types = installed.map((b) => b.type).sort();
      expect(types).toEqual(['atlas', 'chrome']);
      for (const b of installed) {
        expect(b.isInstalled).toBe(true);
        expect(b.resolvedCookiePath).toBeTruthy();
      }
      const atlas = installed.find((b) => b.type === 'atlas');
      expect(atlas?.resolvedCookiePath).toContain('user-1/Cookies');
    });

    it('detects modern Chrome Network/Cookies stores as the owning profile install', async () => {
      fsExistsSync.mockReturnValue(false);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });
      globSync.mockImplementation((pattern: string) =>
        pattern.includes('Google/Chrome') && pattern.includes('Network')
          ? ['/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Network/Cookies']
          : []
      );
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const installed = BrowserCookieReader.getInstalledBrowsers();
      const chrome = installed.find((b) => b.type === 'chrome');

      expect(chrome?.resolvedCookiePath).toContain('Default/Network/Cookies');
    });

    it('picks the most-recently-modified match when wildcard has multiple candidates', async () => {
      // Only Atlas wildcard has matches; other browsers absent.
      fsExistsSync.mockReturnValue(false);
      const older = '/tmp/atlas/host/user-old/Cookies';
      const newer = '/tmp/atlas/host/user-new/Cookies';
      globSync.mockImplementation((pattern: string) =>
        pattern.includes('com.openai.atlas') ? [older, newer] : []
      );
      fsStatSync.mockImplementation((p: string) => ({
        mtime: p.includes('user-new')
          ? new Date('2025-06-01T00:00:00Z')
          : new Date('2025-01-01T00:00:00Z'),
      }));

      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');
      const installed = BrowserCookieReader.getInstalledBrowsers();
      const atlas = installed.find((b) => b.type === 'atlas');

      expect(atlas).toBeDefined();
      expect(atlas?.resolvedCookiePath).toBe(newer);
    });

    it('detects Safari when Cookies.binarycookies exists on disk', async () => {
      installSafariFs();
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');
      const installed = BrowserCookieReader.getInstalledBrowsers();

      const safari = installed.find((b) => b.type === 'safari');
      expect(safari).toBeDefined();
      expect(safari?.name).toBe('Safari');
      expect(safari?.resolvedCookiePath).toContain('Cookies.binarycookies');
    });
  });

  describe('readCookies — unknown / empty states', () => {
    it('throws "Unknown browser type" for an unrecognized browser', async () => {
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      await expect(
        BrowserCookieReader.readCookies(
          'firefox' as unknown as Parameters<typeof BrowserCookieReader.readCookies>[0]
        )
      ).rejects.toThrow(/Unknown browser type/);
    });

    it('returns [] and makes no keychain/DB call when Chrome cookies file is missing', async () => {
      // Chrome uses a wildcard pattern → resolution goes through glob.sync.
      fsExistsSync.mockReturnValue(false);
      globSync.mockReturnValue([]); // No matches = not installed.
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const result = await BrowserCookieReader.readCookies('chrome');

      expect(result).toEqual([]);
      expect(execMock).not.toHaveBeenCalled();
      expect(fsCopyFileSync).not.toHaveBeenCalled();
      expect(dbCtor).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns [] when the cookies DB is present but has no rows', async () => {
      installChromeFs();
      installKeychain();
      installCookieRows([]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const result = await BrowserCookieReader.readCookies('chrome');

      expect(result).toEqual([]);
      expect(dbCtor).toHaveBeenCalledTimes(1);
      expect(dbClose).toHaveBeenCalledTimes(1);
      expect(fsUnlinkSync).toHaveBeenCalledTimes(1);
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  describe('readCookies — Safari binary cookie store', () => {
    it('parses Safari Cookies.binarycookies without keychain or sqlite access', async () => {
      const safariCookieFile = buildSafariBinaryCookies([
        {
          host: '.example.com',
          name: 'safari_session',
          path: '/',
          value: 'safari-value',
          flags: 0x05,
          expiresAt: 8000,
          createdAt: 7000,
        },
      ]);
      installSafariFs(safariCookieFile);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const result = await BrowserCookieReader.readCookies('safari');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        host_key: '.example.com',
        name: 'safari_session',
        value: 'safari-value',
        path: '/',
        is_secure: true,
        is_httponly: true,
        has_expires: true,
        is_persistent: true,
        source_scheme: 2,
        source_port: 443,
      });
      expect(result[0].expires_utc).toBe(12622788800000000);
      expect(execMock).not.toHaveBeenCalled();
      expect(fsCopyFileSync).not.toHaveBeenCalled();
      expect(dbCtor).not.toHaveBeenCalled();
    });

    it('skips malformed Safari cookie entries while preserving valid session cookies', async () => {
      const validCookie = buildSafariBinaryCookies([
        {
          host: '.example.com',
          name: 'session_only',
          path: '/',
          value: 'plain',
          flags: 0,
          expiresAt: 0,
          createdAt: 7000,
        },
        {
          host: '.bad.example.com',
          name: 'bad',
          path: '/',
          value: 'skip-me',
        },
      ]);
      const pageSize = validCookie.readUInt32BE(8);
      const pageOffset = 12;
      const page = Buffer.from(validCookie.subarray(pageOffset, pageOffset + pageSize));
      const malformedOffset = page.readUInt32LE(12);
      page.writeUInt32LE(8, malformedOffset);
      const safariCookieFile = Buffer.concat([validCookie.subarray(0, pageOffset), page]);
      installSafariFs(safariCookieFile);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const result = await BrowserCookieReader.readCookies('safari');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'session_only',
        value: 'plain',
        is_secure: false,
        is_httponly: false,
        has_expires: false,
        is_persistent: false,
        source_scheme: 1,
        source_port: 80,
      });
    });
  });

  describe('readCookies — Chrome (keychain path)', () => {
    it('shells out to `security find-generic-password` with the Chrome keychain account', async () => {
      installChromeFs();
      installKeychain();
      installCookieRows([makeRow({ encrypted_value: encryptV10('v') })]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      await BrowserCookieReader.readCookies('chrome');

      expect(execMock).toHaveBeenCalledTimes(1);
      const [cmd] = execMock.mock.calls[0];
      expect(cmd).toContain('security find-generic-password');
      expect(cmd).toContain('-wa "Chrome"');
    });

    it('decrypts v10 cookies, strips 32-byte prefix, and maps rows to CookieData', async () => {
      installChromeFs();
      installKeychain();
      installCookieRows([
        makeRow({ name: 'a', encrypted_value: encryptV10('valueA') }),
        makeRow({ name: 'b', encrypted_value: encryptV10('valueB'), host_key: '.other.com' }),
      ]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const result = await BrowserCookieReader.readCookies('chrome');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        host_key: '.example.com',
        name: 'a',
        value: 'valueA',
        is_secure: true,
        is_httponly: true,
        has_expires: true,
        is_persistent: true,
        browserProfile: 'Default',
      });
      expect(result[1]).toMatchObject({ host_key: '.other.com', name: 'b', value: 'valueB' });
    });

    it('coerces SQLite 0/1 ints to booleans for boolean-shaped fields', async () => {
      installChromeFs();
      installKeychain();
      installCookieRows([
        makeRow({
          encrypted_value: encryptV10('x'),
          is_secure: 0,
          is_httponly: 0,
          has_expires: 0,
          is_persistent: 0,
        }),
      ]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const [cookie] = await BrowserCookieReader.readCookies('chrome');
      expect(cookie.is_secure).toBe(false);
      expect(cookie.is_httponly).toBe(false);
      expect(cookie.has_expires).toBe(false);
      expect(cookie.is_persistent).toBe(false);
    });

    it('coerces null top_frame_site_key to empty string', async () => {
      installChromeFs();
      installKeychain();
      installCookieRows([makeRow({ encrypted_value: encryptV10('y'), top_frame_site_key: null })]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const [cookie] = await BrowserCookieReader.readCookies('chrome');
      expect(cookie.top_frame_site_key).toBe('');
    });

    it('copies Cookies file to a browser-scoped temp path and deletes it after', async () => {
      installChromeFs();
      installKeychain();
      installCookieRows([makeRow({ encrypted_value: encryptV10('v') })]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      await BrowserCookieReader.readCookies('chrome');

      expect(fsCopyFileSync).toHaveBeenCalledTimes(1);
      const [, dest] = fsCopyFileSync.mock.calls[0];
      expect(dest).toContain('Cookies-chrome-copy');
      expect(dbCtor).toHaveBeenCalledWith(dest, { readonly: true });
      expect(dbClose).toHaveBeenCalledTimes(1);
      expect(fsUnlinkSync).toHaveBeenCalledWith(dest);
    });

    it('accepts plaintext ASCII values (non-v10 prefix) as-is', async () => {
      installChromeFs();
      installKeychain();
      installCookieRows([
        makeRow({ name: 'plain', encrypted_value: Buffer.from('plain-ascii-value', 'utf8') }),
      ]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const result = await BrowserCookieReader.readCookies('chrome');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ name: 'plain', value: 'plain-ascii-value' });
    });

    it('reads all Chrome profile cookie DBs and keeps matching cookie identities profile-scoped', async () => {
      fsExistsSync.mockReturnValue(false);
      globSync.mockImplementation((pattern: string) => {
        if (pattern.includes('Google/Chrome')) {
          return [
            '/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Cookies',
            '/tmp/mac-app-test/Library/Application Support/Google/Chrome/Profile 1/Cookies',
          ];
        }
        return [];
      });
      fsStatSync.mockImplementation((p: string) => ({
        mtime: p.includes('Profile 1')
          ? new Date('2025-06-01T00:00:00Z')
          : new Date('2025-01-01T00:00:00Z'),
      }));
      installKeychain();

      prepareMock
        .mockImplementationOnce(() => ({
          all: vi.fn(() => [
            makeRow({
              name: 'session',
              encrypted_value: encryptV10('new-profile-cookie'),
              last_update_utc: 13500000000000000,
              last_access_utc: 13400000000000000,
            }),
          ]),
          get: vi.fn(() => undefined),
          run: vi.fn(() => ({ changes: 0 })),
        }))
        .mockImplementationOnce(() => ({
          all: vi.fn(() => [
            makeRow({
              name: 'session',
              encrypted_value: encryptV10('old-profile-cookie'),
              last_update_utc: 13500000000000000,
              last_access_utc: 13300000000000000,
            }),
          ]),
          get: vi.fn(() => undefined),
          run: vi.fn(() => ({ changes: 0 })),
        }));

      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');
      const result = await BrowserCookieReader.readCookies('chrome');

      expect(fsCopyFileSync).toHaveBeenCalledTimes(2);
      expect(execMock).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        host_key: '.example.com',
        name: 'session',
        value: 'new-profile-cookie',
        browserProfile: 'Profile 1',
      });
      expect(result[1]).toMatchObject({
        host_key: '.example.com',
        name: 'session',
        value: 'old-profile-cookie',
        browserProfile: 'Default',
      });
    });

    it('records Default as browserProfile for modern Default/Network/Cookies paths', async () => {
      fsExistsSync.mockReturnValue(false);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });
      globSync.mockImplementation((pattern: string) =>
        pattern.includes('Google/Chrome') && pattern.includes('Network')
          ? ['/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Network/Cookies']
          : []
      );
      installKeychain();
      installCookieRows([
        makeRow({ name: 'session', encrypted_value: encryptV10('network-cookie') }),
      ]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const result = await BrowserCookieReader.readCookies('chrome');

      expect(fsCopyFileSync).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'session',
        value: 'network-cookie',
        browserProfile: 'Default',
      });
    });
  });

  describe('readCookies — Atlas (manual password path)', () => {
    it('throws a helpful error when keychainPassword is missing', async () => {
      installAtlasFs();
      installCookieRows([makeRow({ encrypted_value: encryptV10('v', ATLAS_KEY_PASSWORD) })]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      await expect(BrowserCookieReader.readCookies('atlas')).rejects.toThrow(
        /requires a keychain password/
      );
      // Keychain CLI must NOT be used for Atlas.
      expect(execMock).not.toHaveBeenCalled();
    });

    it('does not shell out to `security` when a manual password is provided', async () => {
      installAtlasFs();
      installCookieRows([
        makeRow({ encrypted_value: encryptV10('atlas-cookie', ATLAS_KEY_PASSWORD) }),
      ]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const result = await BrowserCookieReader.readCookies('atlas', {
        keychainPassword: ATLAS_KEY_PASSWORD,
      });

      expect(execMock).not.toHaveBeenCalled();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ value: 'atlas-cookie' });
    });

    it('uses a browser-scoped temp path for the Atlas DB copy', async () => {
      installAtlasFs();
      installCookieRows([makeRow({ encrypted_value: encryptV10('v', ATLAS_KEY_PASSWORD) })]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      await BrowserCookieReader.readCookies('atlas', { keychainPassword: ATLAS_KEY_PASSWORD });

      const [, dest] = fsCopyFileSync.mock.calls[0];
      expect(dest).toContain('Cookies-atlas-copy');
      // Destination must differ from the chrome path so concurrent reads don't collide.
      expect(dest).not.toContain('Cookies-chrome-copy');
    });
  });

  describe('readCookies — skip-and-continue on malformed cookies', () => {
    it('skips cookies with empty encrypted_value but keeps decryptable siblings', async () => {
      installChromeFs();
      installKeychain();
      installCookieRows([
        makeRow({ name: 'empty', encrypted_value: Buffer.alloc(0) }),
        makeRow({ name: 'good', encrypted_value: encryptV10('kept') }),
      ]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const result = await BrowserCookieReader.readCookies('chrome');
      expect(result.map((c) => c.name)).toEqual(['good']);
    });

    it('does not throw when v10 ciphertext has a non-AES-block length', async () => {
      installChromeFs();
      installKeychain();
      const malformed = Buffer.concat([Buffer.from('v10'), Buffer.from('xxx')]);
      installCookieRows([
        makeRow({ name: 'malformed', encrypted_value: malformed }),
        makeRow({ name: 'good', encrypted_value: encryptV10('kept') }),
      ]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      const result = await BrowserCookieReader.readCookies('chrome');
      expect(result.map((c) => c.name)).toEqual(['good']);
    });
  });

  describe('readCookies — error states', () => {
    it('throws "Failed to get <browser> encryption key" when the keychain CLI fails (Chrome)', async () => {
      installChromeFs();
      installKeychainError(new Error('security denied'));
      installCookieRows([]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      await expect(BrowserCookieReader.readCookies('chrome')).rejects.toThrow(
        /Failed to get Chrome encryption key from keychain/
      );
    });

    it('throws a wrong-password error when <10% of >10 rows decrypt successfully', async () => {
      installChromeFs();
      installKeychain('wrong-password'); // keychain returns a password that won't match our ciphertext.
      // 15 rows all encrypted with the CORRECT password — almost all will fail under the wrong key.
      const rows: StubRow[] = Array.from({ length: 15 }, (_, i) =>
        makeRow({ name: `row-${i}`, encrypted_value: encryptV10(`value-${i}`) })
      );
      installCookieRows(rows);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      await expect(BrowserCookieReader.readCookies('chrome')).rejects.toThrow(
        /keychain password may be incorrect/
      );
    });
  });

  describe('auth boundary — Atlas manual password vs Chrome keychain', () => {
    it('Chrome never requires config.keychainPassword (it comes from the keychain CLI)', async () => {
      installChromeFs();
      installKeychain();
      installCookieRows([makeRow({ encrypted_value: encryptV10('v') })]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      // Without any config, Chrome succeeds.
      const result = await BrowserCookieReader.readCookies('chrome');
      expect(result).toHaveLength(1);
      expect(execMock).toHaveBeenCalledTimes(1);
    });

    it('Atlas rejects without config.keychainPassword even when the CLI would return a password', async () => {
      installAtlasFs();
      installKeychain(); // Would return a password if consulted — but Atlas should not consult it.
      installCookieRows([makeRow({ encrypted_value: encryptV10('v', ATLAS_KEY_PASSWORD) })]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      await expect(BrowserCookieReader.readCookies('atlas')).rejects.toThrow(
        /requires a keychain password/
      );
      expect(execMock).not.toHaveBeenCalled();
    });
  });

  describe('boundary invariant (HTTP)', () => {
    it('makes zero outbound HTTP calls during readCookies', async () => {
      installChromeFs();
      installKeychain();
      installCookieRows([makeRow({ encrypted_value: encryptV10('v') })]);
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      await BrowserCookieReader.readCookies('chrome');

      expect(fetchCaptures).toHaveLength(0);
    });

    it('makes zero outbound HTTP calls during getInstalledBrowsers', async () => {
      fsExistsSync.mockReturnValue(false);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });
      globSync.mockImplementation((pattern: string) =>
        pattern.includes('Google/Chrome')
          ? ['/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Cookies']
          : []
      );
      const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');

      BrowserCookieReader.getInstalledBrowsers();

      expect(fetchCaptures).toHaveLength(0);
    });
  });
});
