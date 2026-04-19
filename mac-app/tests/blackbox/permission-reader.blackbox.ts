/**
 * permission-reader domain blackbox
 *
 * Surface under test:
 *   - main/services/permissionReader.ts       (PermissionReader.readPermissions: Chrome Preferences → PermissionData)
 *   - main/services/chromeProfileResolver.ts  (resolveChromeProfilePath — consumed via readPermissions)
 *
 * Observable behavior exercised here:
 *   - readPermissions returns empty PermissionData when Chrome Preferences cannot be resolved.
 *   - readPermissions returns empty PermissionData when Preferences JSON has no content_settings.exceptions.
 *   - readPermissions returns empty PermissionData when Preferences JSON is invalid (errors swallowed).
 *   - readPermissions extracts every supported permission type from content_settings.exceptions.
 *   - Chrome internal permission names are mapped to Web API names (media_stream_camera → camera, etc.).
 *   - Only settings with value 1 (allow) or 2 (block) are returned — default (0) and ask are filtered.
 *   - Origin patterns with trailing ",*" have the suffix stripped; "[*.]" subdomain patterns are preserved.
 *   - grantCount reflects the number of returned grants.
 *   - hash is a deterministic 16-char hex string that is stable across input ordering and equal
 *     input shapes, and changes when any grant changes.
 *   - Permission types not in the supported list (e.g. "cookies") are ignored entirely.
 *   - Malformed per-origin values (non-objects, nulls, missing setting) are skipped, not thrown.
 *
 * Boundary capture: N/A — permission-reader makes zero outbound HTTP calls. The only system
 * boundaries are the filesystem (Chrome Preferences JSON). We stub the filesystem and assert on
 * the PermissionData shape produced. `fetchCaptures` is still asserted empty as a hard invariant.
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// We inline the electron stub (not import from ./electron-stubs) to avoid cross-file
// vi.mock hoisting conflicts with other suites that also stub 'electron'.
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

// ── Mock the system boundaries PermissionReader reaches across ──────────────

// `glob.sync` — drives profile discovery in chromeProfileResolver.
const globSync = vi.hoisted(() => vi.fn<(pattern: string) => string[]>(() => []));
vi.mock('glob', () => ({ glob: { sync: globSync }, sync: globSync }));

// `fs` — existsSync/statSync drive resolver; readFileSync drives permission reader.
const fsExistsSync = vi.hoisted(() => vi.fn<(p: string) => boolean>(() => false));
const fsStatSync = vi.hoisted(() =>
  vi.fn<(p: string) => { mtime: Date }>(() => ({ mtime: new Date(0) }))
);
const fsReadFileSync = vi.hoisted(() => vi.fn<(p: string, enc?: string) => string>(() => ''));
vi.mock('fs', () => ({
  default: {
    existsSync: fsExistsSync,
    statSync: fsStatSync,
    readFileSync: fsReadFileSync,
  },
  existsSync: fsExistsSync,
  statSync: fsStatSync,
  readFileSync: fsReadFileSync,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Default filesystem state: Chrome installed with a single "Default" profile that
 * contains the Preferences file. Tests override `fsReadFileSync` to supply the JSON
 * body for the Preferences file.
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
 * Build a minimal Chrome Preferences JSON body with the given content_settings.exceptions.
 */
function prefsWith(exceptions: Record<string, unknown>): string {
  return JSON.stringify({ profile: { content_settings: { exceptions } } });
}

/**
 * Identity helper that documents the shape of Chrome's per-permission entries
 * at call sites. Chrome's real format looks like:
 *   { "https://www.amazon.com,*": { setting: 1 }, ... }
 * Values are intentionally `unknown` so individual tests can pass in malformed
 * shapes (null, strings, missing `setting`) to exercise the skip-and-continue paths.
 */
function perms(entries: Record<string, unknown>): Record<string, unknown> {
  return entries;
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('permission-reader blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    globSync.mockReset();
    fsExistsSync.mockReset();
    fsStatSync.mockReset();
    fsReadFileSync.mockReset();
    // Capture any accidental outbound fetches so the boundary invariant is enforced.
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  describe('empty state — Chrome Preferences cannot be resolved', () => {
    it('returns { grants: [], hash: "", grantCount: 0 } when Chrome is not installed', async () => {
      fsExistsSync.mockReturnValue(false); // Chrome base dir missing.
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();

      expect(result).toEqual({ grants: [], hash: '', grantCount: 0 });
      expect(fsReadFileSync).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns empty data when Chrome is installed but no profile matches', async () => {
      fsExistsSync.mockReturnValue(true); // Chrome base dir exists.
      globSync.mockReturnValue([]); // ... but no profile Preferences files.
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();

      expect(result).toEqual({ grants: [], hash: '', grantCount: 0 });
      expect(fsReadFileSync).not.toHaveBeenCalled();
    });
  });

  describe('empty state — Preferences file present but uninteresting', () => {
    it('returns empty data when profile.content_settings.exceptions is missing', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(JSON.stringify({ profile: { content_settings: {} } }));
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();

      expect(result).toEqual({ grants: [], hash: '', grantCount: 0 });
    });

    it('returns empty data when exceptions exists but contains only unsupported permission types', async () => {
      installDefaultFs();
      // "cookies" is a real Chrome content-setting key, but not in our supported list.
      fsReadFileSync.mockReturnValue(
        prefsWith({
          cookies: perms({ 'https://example.com,*': { setting: 1 } }),
        })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();
      expect(result.grants).toEqual([]);
      expect(result.grantCount).toBe(0);
    });

    it('returns empty data when all supported permission types contain only default (0) or ask settings', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(
        prefsWith({
          geolocation: perms({
            'https://a.com,*': { setting: 0 }, // default — skipped
            'https://b.com,*': { setting: 3 }, // ask — skipped
          }),
          notifications: perms({
            'https://c.com,*': {}, // missing setting — skipped
          }),
        })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();
      expect(result.grants).toEqual([]);
      expect(result.grantCount).toBe(0);
    });
  });

  describe('happy path — extracts + maps grants', () => {
    it('returns every supported permission with allow (1) or block (2) settings', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(
        prefsWith({
          geolocation: perms({
            'https://maps.google.com,*': { setting: 1 },
            'https://evil.com,*': { setting: 2 },
          }),
          notifications: perms({ 'https://news.com,*': { setting: 1 } }),
          clipboard: perms({ 'https://editor.io,*': { setting: 1 } }),
          payment_handler: perms({ 'https://shop.com,*': { setting: 1 } }),
          automatic_downloads: perms({ 'https://dl.com,*': { setting: 2 } }),
        })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();

      expect(result.grantCount).toBe(6);
      expect(result.grants).toEqual(
        expect.arrayContaining([
          { origin: 'https://maps.google.com', permission: 'geolocation', setting: 1 },
          { origin: 'https://evil.com', permission: 'geolocation', setting: 2 },
          { origin: 'https://news.com', permission: 'notifications', setting: 1 },
          { origin: 'https://editor.io', permission: 'clipboard', setting: 1 },
          { origin: 'https://shop.com', permission: 'payment_handler', setting: 1 },
          { origin: 'https://dl.com', permission: 'automatic_downloads', setting: 2 },
        ])
      );
    });

    it('maps Chrome internal permission names to Web API names', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(
        prefsWith({
          media_stream_camera: perms({ 'https://zoom.us,*': { setting: 1 } }),
          media_stream_mic: perms({ 'https://meet.com,*': { setting: 1 } }),
          midi_sysex: perms({ 'https://studio.io,*': { setting: 1 } }),
          usb_guard: perms({ 'https://hw.dev,*': { setting: 2 } }),
          serial_guard: perms({ 'https://arduino.cc,*': { setting: 1 } }),
          bluetooth_guard: perms({ 'https://ble.app,*': { setting: 2 } }),
          hid_guard: perms({ 'https://gamepad.io,*': { setting: 1 } }),
          window_placement: perms({ 'https://wm.app,*': { setting: 1 } }),
          local_fonts: perms({ 'https://font.design,*': { setting: 1 } }),
          idle_detection: perms({ 'https://away.io,*': { setting: 1 } }),
        })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();

      // Build a map of origin → permission for easier assertions.
      const byOrigin = Object.fromEntries(result.grants.map((g) => [g.origin, g.permission]));
      expect(byOrigin).toMatchObject({
        'https://zoom.us': 'camera',
        'https://meet.com': 'microphone',
        'https://studio.io': 'midi',
        'https://hw.dev': 'usb',
        'https://arduino.cc': 'serial',
        'https://ble.app': 'bluetooth',
        'https://gamepad.io': 'hid',
        'https://wm.app': 'window-management',
        'https://font.design': 'local-fonts',
        'https://away.io': 'idle-detection',
      });
    });

    it('strips the ",*" suffix Chrome uses for secondary patterns', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(
        prefsWith({
          geolocation: perms({ 'https://www.amazon.com,*': { setting: 1 } }),
        })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const [grant] = (await PermissionReader.readPermissions()).grants;
      expect(grant.origin).toBe('https://www.amazon.com');
    });

    it('preserves "[*.]" subdomain wildcard patterns for downstream matching', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(
        prefsWith({
          geolocation: perms({ '[*.]amazon.com,*': { setting: 1 } }),
        })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const [grant] = (await PermissionReader.readPermissions()).grants;
      expect(grant.origin).toBe('[*.]amazon.com');
    });

    it('filters default (0), ask (3), and missing setting values, keeping only 1 and 2', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(
        prefsWith({
          geolocation: perms({
            'https://allow.com,*': { setting: 1 },
            'https://block.com,*': { setting: 2 },
            'https://default.com,*': { setting: 0 },
            'https://ask.com,*': { setting: 3 },
            'https://nosetting.com,*': {},
          }),
        })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();
      const origins = result.grants.map((g) => g.origin).sort();
      expect(origins).toEqual(['https://allow.com', 'https://block.com']);
    });

    it('skips malformed per-origin values without throwing', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(
        prefsWith({
          geolocation: perms({
            'https://broken.com,*': null, // value is null, skip
            'https://string.com,*': 'not-an-object', // value is a string, skip
            'https://ok.com,*': { setting: 1 }, // kept
          }),
        })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();
      expect(result.grants).toEqual([
        { origin: 'https://ok.com', permission: 'geolocation', setting: 1 },
      ]);
    });

    it('skips supported permission types whose value is not an object', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(
        prefsWith({
          geolocation: 'not-a-settings-map', // malformed — should not throw
          notifications: perms({ 'https://ok.com,*': { setting: 1 } }),
        })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();
      expect(result.grants).toEqual([
        { origin: 'https://ok.com', permission: 'notifications', setting: 1 },
      ]);
    });
  });

  describe('hash behavior (cache-invalidation contract)', () => {
    it('produces a stable 16-char hex hash', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(
        prefsWith({ geolocation: perms({ 'https://a.com,*': { setting: 1 } }) })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const first = await PermissionReader.readPermissions();
      const second = await PermissionReader.readPermissions();

      expect(first.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(second.hash).toBe(first.hash);
    });

    it('produces the same hash regardless of insertion order (grants are sorted before hashing)', async () => {
      installDefaultFs();
      const forwardPrefs = prefsWith({
        geolocation: perms({
          'https://a.com,*': { setting: 1 },
          'https://b.com,*': { setting: 1 },
        }),
      });
      const reversePrefs = prefsWith({
        geolocation: perms({
          'https://b.com,*': { setting: 1 },
          'https://a.com,*': { setting: 1 },
        }),
      });

      fsReadFileSync.mockReturnValueOnce(forwardPrefs);
      const { PermissionReader } = await import('../../main/services/permissionReader');
      const firstResult = await PermissionReader.readPermissions();

      fsReadFileSync.mockReturnValueOnce(reversePrefs);
      const secondResult = await PermissionReader.readPermissions();

      expect(firstResult.hash).toBe(secondResult.hash);
    });

    it('produces a different hash when the grant set changes', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValueOnce(
        prefsWith({ geolocation: perms({ 'https://a.com,*': { setting: 1 } }) })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');
      const first = await PermissionReader.readPermissions();

      fsReadFileSync.mockReturnValueOnce(
        prefsWith({ geolocation: perms({ 'https://a.com,*': { setting: 2 } }) })
      );
      const second = await PermissionReader.readPermissions();

      expect(first.hash).not.toBe(second.hash);
    });
  });

  describe('error state — malformed Preferences', () => {
    it('returns empty data when Preferences JSON is invalid', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue('{not: valid json'); // parse error is caught.
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();

      expect(result).toEqual({ grants: [], hash: '', grantCount: 0 });
    });

    it('returns empty data when readFileSync throws (e.g. permission denied)', async () => {
      installDefaultFs();
      fsReadFileSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });
      const { PermissionReader } = await import('../../main/services/permissionReader');

      const result = await PermissionReader.readPermissions();

      expect(result).toEqual({ grants: [], hash: '', grantCount: 0 });
    });
  });

  describe('boundary invariant (HTTP)', () => {
    it('makes zero outbound HTTP calls during readPermissions', async () => {
      installDefaultFs();
      fsReadFileSync.mockReturnValue(
        prefsWith({
          geolocation: perms({ 'https://a.com,*': { setting: 1 } }),
          media_stream_camera: perms({ 'https://b.com,*': { setting: 2 } }),
        })
      );
      const { PermissionReader } = await import('../../main/services/permissionReader');

      await PermissionReader.readPermissions();

      expect(fetchCaptures).toHaveLength(0);
    });
  });
});
