/**
 * Blackbox suite for `AtlasCredentialStore` (main/services/atlasCredentialStore.ts).
 *
 * The store is a thin, static wrapper that persists the user's Atlas (ChatGPT)
 * keychain password on disk, encrypted via Electron's `safeStorage`
 * (macOS-Keychain-backed). The observable surface is just four static methods:
 *
 *   isEncryptionAvailable() → boolean
 *   storePassword(pw)       → { success, error? }   (+ side effect: writeFile)
 *   getPassword()           → string | null         (+ side effect: readFile)
 *   hasPassword()           → boolean               (+ side effect: existsSync)
 *   clearPassword()         → { success }           (+ side effect: unlinkSync)
 *
 * Tests exercise every branch by driving the stubbed `electron.safeStorage` +
 * `fs` modules and asserting:
 *   - the correct file path is used (from `app.getPath('userData')`)
 *   - plaintext never lands on disk
 *   - failures bubble up as shaped error results (never thrown)
 *
 * There is no HTTP boundary for this domain, so no fetch-capture is installed.
 */
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { stubAllElectron } from './electron-stubs';

stubAllElectron();

// `fs` — AtlasCredentialStore writes to / reads from a single file under
// `userData`. The test controls existence, contents, and failure modes.
const fsExistsSync = vi.hoisted(() => vi.fn<(p: string) => boolean>(() => false));
const fsWriteFileSync = vi.hoisted(() =>
  vi.fn<(p: string, data: Buffer | string) => void>(() => undefined)
);
const fsReadFileSync = vi.hoisted(() => vi.fn<(p: string) => Buffer>(() => Buffer.alloc(0)));
const fsUnlinkSync = vi.hoisted(() => vi.fn<(p: string) => void>(() => undefined));
vi.mock('fs', () => ({
  default: {
    existsSync: fsExistsSync,
    writeFileSync: fsWriteFileSync,
    readFileSync: fsReadFileSync,
    unlinkSync: fsUnlinkSync,
  },
  existsSync: fsExistsSync,
  writeFileSync: fsWriteFileSync,
  readFileSync: fsReadFileSync,
  unlinkSync: fsUnlinkSync,
}));

import { app, safeStorage } from 'electron';
import { AtlasCredentialStore } from '../../main/services/atlasCredentialStore';

const USER_DATA = '/tmp/mac-app-test';
const EXPECTED_PATH = path.join(USER_DATA, 'atlas-keychain.enc');

/**
 * Build a fake "encrypted" buffer the way the default safeStorage stub does
 * (see electron-stubs.ts): encryptString returns Buffer.from(s), decryptString
 * returns b.toString(). Tests can pre-seed readFileSync with this shape.
 */
function fakeEncrypted(plain: string): Buffer {
  return Buffer.from(plain);
}

describe('atlas-credential-store blackbox', () => {
  beforeEach(() => {
    fsExistsSync.mockReset().mockReturnValue(false);
    fsWriteFileSync.mockReset().mockReturnValue(undefined);
    fsReadFileSync.mockReset().mockReturnValue(Buffer.alloc(0));
    fsUnlinkSync.mockReset().mockReturnValue(undefined);

    vi.mocked(app.getPath).mockReturnValue(USER_DATA);
    vi.mocked(safeStorage.isEncryptionAvailable).mockReset().mockReturnValue(true);
    vi.mocked(safeStorage.encryptString)
      .mockReset()
      .mockImplementation((s: string) => Buffer.from(s));
    vi.mocked(safeStorage.decryptString)
      .mockReset()
      .mockImplementation((b: Buffer) => b.toString());
  });

  // ------------------------------------------------------------------
  // auth boundary — safeStorage availability gates both store + get
  // ------------------------------------------------------------------
  describe('auth boundary (safeStorage availability)', () => {
    it('storePassword returns { success:false, error } and writes nothing when encryption is unavailable', () => {
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

      const result = AtlasCredentialStore.storePassword('hunter2');

      expect(result).toEqual({
        success: false,
        error: 'Encryption not available on this system',
      });
      expect(fsWriteFileSync).not.toHaveBeenCalled();
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
    });

    it('getPassword returns null without touching the disk when encryption is unavailable', () => {
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);

      const result = AtlasCredentialStore.getPassword();

      expect(result).toBeNull();
      expect(fsExistsSync).not.toHaveBeenCalled();
      expect(fsReadFileSync).not.toHaveBeenCalled();
    });

    it('isEncryptionAvailable is a transparent pass-through to safeStorage', () => {
      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(true);
      expect(AtlasCredentialStore.isEncryptionAvailable()).toBe(true);

      vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false);
      expect(AtlasCredentialStore.isEncryptionAvailable()).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // happy path — full round-trip
  // ------------------------------------------------------------------
  describe('happy path', () => {
    it('storePassword encrypts via safeStorage and writes to userData/atlas-keychain.enc', () => {
      const result = AtlasCredentialStore.storePassword('correct-horse-battery-staple');

      expect(result).toEqual({ success: true });
      expect(safeStorage.encryptString).toHaveBeenCalledWith('correct-horse-battery-staple');
      expect(fsWriteFileSync).toHaveBeenCalledTimes(1);

      const [writtenPath, writtenBuffer] = fsWriteFileSync.mock.calls[0];
      expect(writtenPath).toBe(EXPECTED_PATH);
      // The file on disk MUST be a Buffer (safeStorage's encrypted output),
      // not a raw plaintext string — regressions would be catastrophic.
      expect(Buffer.isBuffer(writtenBuffer)).toBe(true);
    });

    it('getPassword reads the encrypted file and returns the decrypted plaintext', () => {
      fsExistsSync.mockReturnValue(true);
      fsReadFileSync.mockReturnValue(fakeEncrypted('my-atlas-password'));

      const result = AtlasCredentialStore.getPassword();

      expect(result).toBe('my-atlas-password');
      expect(fsReadFileSync).toHaveBeenCalledWith(EXPECTED_PATH);
      expect(safeStorage.decryptString).toHaveBeenCalledTimes(1);
    });

    it('roundtrip: storePassword then getPassword returns the same value', () => {
      // Capture what storePassword wrote and feed it back through getPassword.
      let onDisk: Buffer | null = null;
      fsWriteFileSync.mockImplementation((_p, data) => {
        onDisk = data as Buffer;
      });

      AtlasCredentialStore.storePassword('round-trip-secret');
      expect(onDisk).not.toBeNull();

      fsExistsSync.mockReturnValue(true);
      fsReadFileSync.mockImplementation(() => onDisk as Buffer);

      expect(AtlasCredentialStore.getPassword()).toBe('round-trip-secret');
    });
  });

  // ------------------------------------------------------------------
  // empty state — no file on disk
  // ------------------------------------------------------------------
  describe('empty state (no stored password)', () => {
    it('getPassword returns null when the credential file does not exist', () => {
      fsExistsSync.mockReturnValue(false);

      const result = AtlasCredentialStore.getPassword();

      expect(result).toBeNull();
      expect(fsReadFileSync).not.toHaveBeenCalled();
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
    });

    it('hasPassword returns false when the credential file does not exist', () => {
      fsExistsSync.mockReturnValue(false);

      expect(AtlasCredentialStore.hasPassword()).toBe(false);
      expect(fsExistsSync).toHaveBeenCalledWith(EXPECTED_PATH);
    });

    it('hasPassword returns true when the credential file exists', () => {
      fsExistsSync.mockReturnValue(true);

      expect(AtlasCredentialStore.hasPassword()).toBe(true);
      expect(fsExistsSync).toHaveBeenCalledWith(EXPECTED_PATH);
    });

    it('clearPassword on empty state is idempotent — skips unlink and reports success', () => {
      fsExistsSync.mockReturnValue(false);

      const result = AtlasCredentialStore.clearPassword();

      expect(result).toEqual({ success: true });
      expect(fsUnlinkSync).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // error state — every try/catch branch
  // ------------------------------------------------------------------
  describe('error state', () => {
    it('storePassword shapes an Error from encryptString into { success:false, error:message }', () => {
      vi.mocked(safeStorage.encryptString).mockImplementation(() => {
        throw new Error('keychain unlocked? no');
      });

      const result = AtlasCredentialStore.storePassword('any');

      expect(result).toEqual({ success: false, error: 'keychain unlocked? no' });
      expect(fsWriteFileSync).not.toHaveBeenCalled();
    });

    it('storePassword shapes an Error from writeFileSync into { success:false, error:message }', () => {
      fsWriteFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const result = AtlasCredentialStore.storePassword('any');

      expect(result).toEqual({ success: false, error: 'EACCES: permission denied' });
    });

    it('storePassword falls back to a generic error message for non-Error throws', () => {
      vi.mocked(safeStorage.encryptString).mockImplementation(() => {
        // Some native modules throw strings; make sure we still return a shaped result.
        throw 'native-exception-as-string';
      });

      const result = AtlasCredentialStore.storePassword('any');

      expect(result).toEqual({ success: false, error: 'Failed to store password' });
    });

    it('getPassword returns null (swallows error) when readFileSync throws', () => {
      fsExistsSync.mockReturnValue(true);
      fsReadFileSync.mockImplementation(() => {
        throw new Error('EIO: disk gremlin');
      });

      const result = AtlasCredentialStore.getPassword();

      expect(result).toBeNull();
    });

    it('getPassword returns null (swallows error) when decryptString throws', () => {
      fsExistsSync.mockReturnValue(true);
      fsReadFileSync.mockReturnValue(Buffer.from('corrupt'));
      vi.mocked(safeStorage.decryptString).mockImplementation(() => {
        throw new Error('bad ciphertext');
      });

      const result = AtlasCredentialStore.getPassword();

      expect(result).toBeNull();
    });

    it('hasPassword returns false when existsSync throws (no bubble)', () => {
      fsExistsSync.mockImplementation(() => {
        throw new Error('fs borked');
      });

      expect(AtlasCredentialStore.hasPassword()).toBe(false);
    });

    it('clearPassword returns { success:false } when unlinkSync throws', () => {
      fsExistsSync.mockReturnValue(true);
      fsUnlinkSync.mockImplementation(() => {
        throw new Error('EBUSY');
      });

      const result = AtlasCredentialStore.clearPassword();

      expect(result).toEqual({ success: false });
    });
  });

  // ------------------------------------------------------------------
  // clearPassword happy path
  // ------------------------------------------------------------------
  describe('clearPassword', () => {
    it('unlinks the credential file at the correct userData path', () => {
      fsExistsSync.mockReturnValue(true);

      const result = AtlasCredentialStore.clearPassword();

      expect(result).toEqual({ success: true });
      expect(fsUnlinkSync).toHaveBeenCalledTimes(1);
      expect(fsUnlinkSync).toHaveBeenCalledWith(EXPECTED_PATH);
    });
  });

  // ------------------------------------------------------------------
  // boundary capture — exact disk path derived from Electron's userData
  // ------------------------------------------------------------------
  describe('boundary capture (disk path)', () => {
    it('always writes/reads under app.getPath("userData") + atlas-keychain.enc', () => {
      vi.mocked(app.getPath).mockReturnValue('/custom/user/data');

      AtlasCredentialStore.storePassword('x');
      expect(fsWriteFileSync.mock.calls[0][0]).toBe('/custom/user/data/atlas-keychain.enc');

      fsExistsSync.mockReturnValue(true);
      fsReadFileSync.mockReturnValue(fakeEncrypted('x'));
      AtlasCredentialStore.getPassword();
      expect(fsReadFileSync.mock.calls[0][0]).toBe('/custom/user/data/atlas-keychain.enc');

      AtlasCredentialStore.hasPassword();
      expect(fsExistsSync).toHaveBeenCalledWith('/custom/user/data/atlas-keychain.enc');

      AtlasCredentialStore.clearPassword();
      expect(fsUnlinkSync).toHaveBeenCalledWith('/custom/user/data/atlas-keychain.enc');

      // app.getPath must be queried with 'userData' specifically — never
      // 'appData' or 'home', which would leak the secret to the wrong scope.
      expect(vi.mocked(app.getPath).mock.calls.every(([arg]) => arg === 'userData')).toBe(true);
    });
  });
});
