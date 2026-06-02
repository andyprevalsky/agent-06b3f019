/**
 * browser-password-reader domain blackbox
 *
 * Surface under test:
 *   - main/services/browserPasswordReader.ts
 *       (BrowserPasswordReader.getInstalledBrowsers / getBrowserConfig /
 *        readPasswords / readAndEncryptPasswords / encryptPassword)
 *
 * Observable behavior exercised here:
 *   - getBrowserConfig(type) returns the static config for known browsers; null for unknown.
 *   - getInstalledBrowsers() resolves wildcard login-data paths via glob.sync and existsSync,
 *     returning only browsers whose Login Data file is found on disk.
 *   - readPasswords('chrome'):
 *       - returns [] when Login Data file is not found (no keychain, no DB open).
 *       - copies the DB to a temp path, opens it readonly, queries `logins`, decrypts
 *         v10 password_value via PBKDF2(keychain, "saltysalt", 1003, 16) → AES-128-CBC,
 *         strips PKCS7 padding, returns PasswordData rows with browserSource set.
 *       - Skips rows with empty username/password or decryption failures, keeps good siblings.
 *       - Cleans up the temp DB copy on success AND on error (finally block).
 *   - readPasswords with config.keychainPassword uses the manual password INSTEAD of the
 *     macOS `security` CLI (no exec call for keychain).
 *   - readPasswords throws with a user-facing message when ALL entries fail to decrypt
 *     AND a manual keychain password was supplied (likely wrong password).
 *   - readPasswords throws when the system keychain lookup fails (no manual password).
 *   - readAndEncryptPasswords wraps readPasswords and produces an RSA-OAEP + AES-256-GCM
 *     base64 envelope per entry (version: 1, encrypted_aes_key, iv, ciphertext).
 *   - encryptPassword(plain) produces a valid v1 envelope that round-trips structurally
 *     (base64 decodable, JSON parseable, fields present and base64-shaped).
 *
 * Boundary capture: N/A — this domain makes zero outbound HTTP calls. System boundaries
 * are macOS Keychain (via `security` CLI), SQLite (`better-sqlite3`), and the filesystem.
 * All three are stubbed; `fetchCaptures` is still asserted empty as a hard invariant.
 *
 * Scope deferrals (per batch prompt):
 *   - flake x5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// Inline the electron stub we need (see cookie-reader.blackbox.ts for the rationale:
// vitest hoists vi.mock declarations globally, so importing helper modules that also
// declare vi.mock('better-sqlite3', ...) would clobber our per-test spies).
vi.mock('electron', () => ({
  app: {
    name: '',
    isPackaged: false,
    getPath: vi.fn((name: string) =>
      name === 'temp' ? '/tmp/mac-app-test-tmp' : '/tmp/mac-app-test'
    ),
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

// ── Mock the system boundaries BrowserPasswordReader reaches across ────────

// `glob.sync` — drives login-data resolution for every browser config.
const globSync = vi.hoisted(() => vi.fn<(pattern: string) => string[]>(() => []));
vi.mock('glob', () => ({ glob: { sync: globSync }, sync: globSync }));

// `fs` — existsSync/statSync drive pattern resolution; copyFileSync/unlinkSync drive reader.
const fsExistsSync = vi.hoisted(() => vi.fn<(p: string) => boolean>(() => false));
const fsStatSync = vi.hoisted(() =>
  vi.fn<(p: string) => { mtime: Date }>(() => ({ mtime: new Date(0) }))
);
const fsCopyFileSync = vi.hoisted(() =>
  vi.fn<(src: string, dest: string) => void>(() => undefined)
);
const fsUnlinkSync = vi.hoisted(() => vi.fn<(p: string) => void>(() => undefined));
vi.mock('fs', () => ({
  default: {
    existsSync: fsExistsSync,
    statSync: fsStatSync,
    copyFileSync: fsCopyFileSync,
    unlinkSync: fsUnlinkSync,
  },
  existsSync: fsExistsSync,
  statSync: fsStatSync,
  copyFileSync: fsCopyFileSync,
  unlinkSync: fsUnlinkSync,
}));

// `child_process.exec` — called via promisify() for `security find-generic-password`.
const execMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ default: { exec: execMock }, exec: execMock }));

// `better-sqlite3` — the logins DB handle. Tests install per-case row fixtures.
interface StubLoginRow {
  origin_url: string;
  username_value: string;
  password_value: Buffer;
  date_last_used: number;
  date_created: number;
}
let stubRows: StubLoginRow[] = [];
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

// ── Helpers ────────────────────────────────────────────────────────────────

const KEYCHAIN_PASSWORD = 'test-keychain-password';
const DERIVED_KEY = crypto.pbkdf2Sync(KEYCHAIN_PASSWORD, 'saltysalt', 1003, 16, 'sha1');
const IV = Buffer.alloc(16, ' ');

/**
 * Build a Chromium-v10 encrypted password value. Unlike cookies, password values do
 * NOT carry a 32-byte random prefix — the decrypted bytes ARE the password directly.
 */
function encryptV10Password(plaintext: string): Buffer {
  const plainBuf = Buffer.from(plaintext, 'utf8');
  // Manual PKCS7 pad to 16-byte block boundary (decryptPassword disables auto-padding).
  const padLen = 16 - (plainBuf.length % 16);
  const padded = Buffer.concat([plainBuf, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', DERIVED_KEY, IV);
  cipher.setAutoPadding(false);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final()]);
  return Buffer.concat([Buffer.from('v10', 'utf8'), ciphertext]);
}

function makeRow(overrides: Partial<StubLoginRow> = {}): StubLoginRow {
  return {
    origin_url: 'https://example.com',
    username_value: 'user@example.com',
    password_value: encryptV10Password('secret-password'),
    date_last_used: 13300000000000000,
    date_created: 13200000000000000,
    ...overrides,
  };
}

/**
 * Default filesystem state: Chrome installed, other browsers absent. The resolver
 * calls glob.sync only for wildcard patterns — Chrome's pattern includes a wildcard
 * segment before "Login Data", so we return a match for it. Other browsers use
 * non-wildcard paths + existsSync.
 */
function installDefaultFs(): void {
  // Non-wildcard browser patterns (Edge/Brave/Arc/etc.) hit existsSync — mark them absent.
  // Chrome + Atlas use wildcard patterns that go through glob.sync instead.
  fsExistsSync.mockReturnValue(false);
  fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });
  globSync.mockImplementation((pattern: string) => {
    if (pattern.includes('Google/Chrome')) {
      return ['/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Login Data'];
    }
    return [];
  });
}

function installKeychain(password: string = KEYCHAIN_PASSWORD): void {
  // execAsync = promisify(exec). The shim must respect the Node callback contract.
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

function installLoginRows(rows: StubLoginRow[]): void {
  stubRows = rows;
  prepareMock.mockImplementation(() => ({
    all: vi.fn(() => stubRows),
    get: vi.fn(() => undefined),
    run: vi.fn(() => ({ changes: 0 })),
  }));
}

/** Wire up Chrome-installed + working keychain + given rows. */
function installReaderEnv(rows: StubLoginRow[]): void {
  installDefaultFs();
  installKeychain();
  installLoginRows(rows);
}

// ── Suite ──────────────────────────────────────────────────────────────────

describe('browser-password-reader blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    globSync.mockReset();
    fsExistsSync.mockReset();
    fsStatSync.mockReset();
    fsCopyFileSync.mockReset();
    fsUnlinkSync.mockReset();
    execMock.mockReset();
    prepareMock.mockReset();
    // Preserve dbCtor implementation (installed by vi.mock factory); clear call history only.
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
    it('returns the config for a known browser type', async () => {
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');
      const cfg = BrowserPasswordReader.getBrowserConfig('chrome');
      expect(cfg).not.toBeNull();
      expect(cfg?.type).toBe('chrome');
      expect(cfg?.name).toBe('Chrome');
      expect(cfg?.keychainEntry).toBe('Chrome Safe Storage');
      expect(cfg?.keychainAccount).toBe('Chrome');
      expect(cfg?.loginDataPathPattern).toContain('Google/Chrome');
    });

    it('returns configs with the expected keychain entries for each supported browser', async () => {
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');
      // Spot-check a handful — the full matrix is the whole BROWSERS record.
      expect(BrowserPasswordReader.getBrowserConfig('edge')?.keychainEntry).toBe(
        'Microsoft Edge Safe Storage'
      );
      expect(BrowserPasswordReader.getBrowserConfig('brave')?.keychainEntry).toBe(
        'Brave Safe Storage'
      );
      expect(BrowserPasswordReader.getBrowserConfig('atlas')?.keychainEntry).toBe(
        'ChatGPT Safe Storage'
      );
      expect(BrowserPasswordReader.getBrowserConfig('atlas')?.keychainAccount).toBe('ChatGPT');
    });

    it('returns null for an unknown browser type', async () => {
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(BrowserPasswordReader.getBrowserConfig('firefox' as any)).toBeNull();
    });
  });

  describe('getInstalledBrowsers', () => {
    it('returns only browsers whose login data path resolves on disk', async () => {
      installDefaultFs(); // Chrome only
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const installed = BrowserPasswordReader.getInstalledBrowsers();
      const types = installed.map((b) => b.type);
      expect(types).toEqual(['chrome']);
      expect(installed[0].isInstalled).toBe(true);
      expect(installed[0].resolvedLoginDataPath).toContain('Login Data');
    });

    it('returns [] when no browsers have Login Data files on disk', async () => {
      fsExistsSync.mockReturnValue(false);
      globSync.mockReturnValue([]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      expect(BrowserPasswordReader.getInstalledBrowsers()).toEqual([]);
    });

    it('picks the most recently modified file when the wildcard pattern matches multiple', async () => {
      fsExistsSync.mockReturnValue(false);
      globSync.mockImplementation((pattern: string) => {
        if (pattern.includes('Google/Chrome')) {
          return [
            '/tmp/Chrome/A/Login Data',
            '/tmp/Chrome/B/Login Data',
            '/tmp/Chrome/C/Login Data',
          ];
        }
        return [];
      });
      fsStatSync.mockImplementation((p: string) => {
        if (p.includes('/B/')) return { mtime: new Date('2025-06-01T00:00:00Z') };
        if (p.includes('/A/')) return { mtime: new Date('2025-01-01T00:00:00Z') };
        return { mtime: new Date('2024-01-01T00:00:00Z') };
      });

      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');
      const installed = BrowserPasswordReader.getInstalledBrowsers();
      const chrome = installed.find((b) => b.type === 'chrome');
      expect(chrome?.resolvedLoginDataPath).toBe('/tmp/Chrome/B/Login Data');
    });
  });

  describe('readPasswords — empty / not-installed state', () => {
    it('returns [] and makes no keychain or DB call when Login Data is not found', async () => {
      fsExistsSync.mockReturnValue(false);
      globSync.mockReturnValue([]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const result = await BrowserPasswordReader.readPasswords('chrome');

      expect(result).toEqual([]);
      expect(execMock).not.toHaveBeenCalled();
      expect(fsCopyFileSync).not.toHaveBeenCalled();
      expect(dbCtor).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns [] when the logins table has no rows', async () => {
      installReaderEnv([]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const result = await BrowserPasswordReader.readPasswords('chrome');

      expect(result).toEqual([]);
      expect(dbCtor).toHaveBeenCalledTimes(1);
      expect(dbClose).toHaveBeenCalledTimes(1);
      expect(fsUnlinkSync).toHaveBeenCalledTimes(1);
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  describe('readPasswords — happy path (decrypt + return)', () => {
    it('decrypts v10 password rows and returns PasswordData with the correct browserSource', async () => {
      installReaderEnv([
        makeRow({
          origin_url: 'https://amazon.com',
          username_value: 'alice@example.com',
          password_value: encryptV10Password('alice-pw'),
          date_last_used: 13400000000000000,
          date_created: 13399000000000000,
        }),
        makeRow({
          origin_url: 'https://github.com',
          username_value: 'bob@example.com',
          password_value: encryptV10Password('bob-pw'),
        }),
      ]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const result = await BrowserPasswordReader.readPasswords('chrome');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        origin: 'https://amazon.com',
        username: 'alice@example.com',
        password: 'alice-pw',
        dateLastUsed: 13400000000000000,
        dateCreated: 13399000000000000,
        browserSource: 'chrome',
        browserProfile: 'Default',
      });
      expect(result[1]).toMatchObject({
        origin: 'https://github.com',
        username: 'bob@example.com',
        password: 'bob-pw',
        browserSource: 'chrome',
      });
    });

    it('copies the Login Data file to a temp path, opens readonly, and cleans up after', async () => {
      installReaderEnv([makeRow({ password_value: encryptV10Password('p') })]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      await BrowserPasswordReader.readPasswords('chrome');

      expect(fsCopyFileSync).toHaveBeenCalledTimes(1);
      const [, dest] = fsCopyFileSync.mock.calls[0];
      expect(String(dest)).toContain('LoginData-chrome-copy');
      expect(dbCtor).toHaveBeenCalledWith(dest, { readonly: true });
      expect(dbClose).toHaveBeenCalledTimes(1);
      expect(fsUnlinkSync).toHaveBeenCalledWith(dest);
    });

    it('uses the provided manual keychain password (no security CLI call)', async () => {
      installDefaultFs();
      installLoginRows([makeRow({ password_value: encryptV10Password('manual-pw') })]);
      // execMock intentionally left unconfigured — it MUST NOT be called in this path.
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const result = await BrowserPasswordReader.readPasswords('chrome', {
        keychainPassword: KEYCHAIN_PASSWORD,
      });

      expect(result).toHaveLength(1);
      expect(result[0].password).toBe('manual-pw');
      expect(execMock).not.toHaveBeenCalled();
    });

    it('coerces missing date fields (0/null) to 0', async () => {
      installReaderEnv([
        makeRow({
          password_value: encryptV10Password('x'),
          date_last_used: 0,
          date_created: 0,
        }),
      ]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const [entry] = await BrowserPasswordReader.readPasswords('chrome');
      expect(entry.dateLastUsed).toBe(0);
      expect(entry.dateCreated).toBe(0);
    });

    it('reads all Chrome profile Login Data files and keeps the newest duplicate credential', async () => {
      fsExistsSync.mockReturnValue(false);
      globSync.mockImplementation((pattern: string) => {
        if (pattern.includes('Google/Chrome')) {
          return [
            '/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Login Data',
            '/tmp/mac-app-test/Library/Application Support/Google/Chrome/Profile 1/Login Data',
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
              origin_url: 'https://github.com',
              username_value: 'same@example.com',
              password_value: encryptV10Password('new-profile-pw'),
              date_last_used: 13500000000000000,
              date_created: 13400000000000000,
            }),
          ]),
          get: vi.fn(() => undefined),
          run: vi.fn(() => ({ changes: 0 })),
        }))
        .mockImplementationOnce(() => ({
          all: vi.fn(() => [
            makeRow({
              origin_url: 'https://github.com',
              username_value: 'same@example.com',
              password_value: encryptV10Password('old-profile-pw'),
              date_last_used: 13500000000000000,
              date_created: 13300000000000000,
            }),
          ]),
          get: vi.fn(() => undefined),
          run: vi.fn(() => ({ changes: 0 })),
        }));

      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');
      const result = await BrowserPasswordReader.readPasswords('chrome');

      expect(fsCopyFileSync).toHaveBeenCalledTimes(2);
      expect(execMock).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        origin: 'https://github.com',
        username: 'same@example.com',
        password: 'new-profile-pw',
        browserSource: 'chrome',
        browserProfile: 'Profile 1',
      });
    });
  });

  describe('readPasswords — skip-and-continue', () => {
    it('skips rows with empty username or empty password_value', async () => {
      installReaderEnv([
        makeRow({ username_value: '', password_value: encryptV10Password('skipped') }),
        makeRow({ username_value: 'ok@example.com', password_value: Buffer.alloc(0) }),
        makeRow({ username_value: 'ok2@example.com', password_value: encryptV10Password('kept') }),
      ]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const result = await BrowserPasswordReader.readPasswords('chrome');
      expect(result.map((r) => r.username)).toEqual(['ok2@example.com']);
      expect(result[0].password).toBe('kept');
    });

    it('skips rows whose ciphertext is malformed but keeps decryptable siblings', async () => {
      // v10 prefix + non-block-multiple ciphertext → AES-CBC final() throws → decryptPassword catches and returns null.
      const malformed = Buffer.concat([Buffer.from('v10'), Buffer.from('xxx')]);
      installReaderEnv([
        makeRow({ username_value: 'bad@example.com', password_value: malformed }),
        makeRow({
          username_value: 'good@example.com',
          password_value: encryptV10Password('good-pw'),
        }),
      ]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const result = await BrowserPasswordReader.readPasswords('chrome');
      expect(result.map((r) => r.username)).toEqual(['good@example.com']);
    });

    it('accepts plaintext ASCII values (non-v10 prefix) as-is', async () => {
      installReaderEnv([
        makeRow({
          username_value: 'plain@example.com',
          password_value: Buffer.from('plaintext-password', 'utf8'),
        }),
      ]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const result = await BrowserPasswordReader.readPasswords('chrome');
      expect(result).toHaveLength(1);
      expect(result[0].password).toBe('plaintext-password');
    });
  });

  describe('readPasswords — error state', () => {
    it('throws a user-facing error when ALL decryption fails AND a manual password was provided', async () => {
      installDefaultFs();
      // Rows encrypted with the REAL key…
      installLoginRows([
        makeRow({ password_value: encryptV10Password('x') }),
        makeRow({ password_value: encryptV10Password('y') }),
      ]);
      // …but caller supplies the WRONG password — every decryption fails the printable-ASCII check.
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      await expect(
        BrowserPasswordReader.readPasswords('chrome', { keychainPassword: 'wrong-password' })
      ).rejects.toThrow(/Failed to decrypt passwords/);
      // Temp file still cleaned up even on throw (finally block).
      expect(fsUnlinkSync).toHaveBeenCalledTimes(1);
    });

    it('throws with an install hint when the system keychain lookup fails', async () => {
      installDefaultFs();
      installKeychainError(new Error('security: entry not found'));
      installLoginRows([]); // DB opens cleanly; failure occurs at getEncryptionKey.
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      await expect(BrowserPasswordReader.readPasswords('chrome')).rejects.toThrow(
        /Failed to get Chrome encryption key from keychain/
      );
      // Even on keychain error, the finally block still cleans up the temp DB copy.
      expect(fsUnlinkSync).toHaveBeenCalledTimes(1);
    });

    it('throws when given an unknown browser type', async () => {
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        BrowserPasswordReader.readPasswords('firefox' as any)
      ).rejects.toThrow(/Unknown browser type/);
    });
  });

  describe('encryptPassword', () => {
    it('produces a v1 envelope with base64-shaped fields', async () => {
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');
      const envelopeB64 = await BrowserPasswordReader.encryptPassword('secret-value');
      const envelopeJson = Buffer.from(envelopeB64, 'base64').toString('utf8');
      const envelope = JSON.parse(envelopeJson);

      expect(envelope.version).toBe(1);
      expect(typeof envelope.encrypted_aes_key).toBe('string');
      expect(typeof envelope.iv).toBe('string');
      expect(typeof envelope.ciphertext).toBe('string');
      // RSA-2048-OAEP ciphertext is exactly 256 bytes → 344 base64 chars.
      expect(Buffer.from(envelope.encrypted_aes_key, 'base64').length).toBe(256);
      // IV is 12 bytes for AES-GCM.
      expect(Buffer.from(envelope.iv, 'base64').length).toBe(12);
      // Ciphertext = AES-GCM(pw) || 16-byte auth tag. For 'secret-value' (12 bytes) → 28 bytes.
      expect(Buffer.from(envelope.ciphertext, 'base64').length).toBe(12 + 16);
    });

    it('produces a different envelope on each call (fresh AES key + IV)', async () => {
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');
      const e1 = await BrowserPasswordReader.encryptPassword('same-password');
      const e2 = await BrowserPasswordReader.encryptPassword('same-password');
      expect(e1).not.toBe(e2);
    });
  });

  describe('readAndEncryptPasswords', () => {
    it('returns entries with encryptedPassword instead of password, preserving metadata', async () => {
      installReaderEnv([
        makeRow({
          origin_url: 'https://shop.com',
          username_value: 'carol@example.com',
          password_value: encryptV10Password('carol-pw'),
          date_last_used: 13500000000000000,
          date_created: 13499000000000000,
        }),
      ]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const result = await BrowserPasswordReader.readAndEncryptPasswords('chrome');

      expect(result).toHaveLength(1);
      const entry = result[0];
      expect(entry).toMatchObject({
        origin: 'https://shop.com',
        username: 'carol@example.com',
        dateLastUsed: 13500000000000000,
        dateCreated: 13499000000000000,
        browserSource: 'chrome',
        browserProfile: 'Default',
      });
      // Plaintext password is never in the returned shape.
      expect(entry).not.toHaveProperty('password');
      expect(typeof entry.encryptedPassword).toBe('string');
      // And it is a valid envelope.
      const envelope = JSON.parse(Buffer.from(entry.encryptedPassword, 'base64').toString('utf8'));
      expect(envelope.version).toBe(1);
      expect(typeof envelope.encrypted_aes_key).toBe('string');
      expect(typeof envelope.iv).toBe('string');
      expect(typeof envelope.ciphertext).toBe('string');
    });

    it('returns [] when readPasswords returns no rows', async () => {
      installReaderEnv([]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      const result = await BrowserPasswordReader.readAndEncryptPasswords('chrome');
      expect(result).toEqual([]);
    });
  });

  describe('boundary invariant (HTTP)', () => {
    it('makes zero outbound HTTP calls during readPasswords', async () => {
      installReaderEnv([makeRow({ password_value: encryptV10Password('v') })]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      await BrowserPasswordReader.readPasswords('chrome');

      expect(fetchCaptures).toHaveLength(0);
    });

    it('makes zero outbound HTTP calls during readAndEncryptPasswords', async () => {
      installReaderEnv([makeRow({ password_value: encryptV10Password('v') })]);
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');

      await BrowserPasswordReader.readAndEncryptPasswords('chrome');

      expect(fetchCaptures).toHaveLength(0);
    });

    it('makes zero outbound HTTP calls during encryptPassword', async () => {
      const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');
      await BrowserPasswordReader.encryptPassword('anything');
      expect(fetchCaptures).toHaveLength(0);
    });
  });
});
