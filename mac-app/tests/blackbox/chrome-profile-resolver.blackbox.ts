/**
 * chrome-profile-resolver domain blackbox
 *
 * Surface under test:
 *   - main/services/chromeProfileResolver.ts
 *       * resolveChromeProfileDir(): string | null
 *       * resolveChromeProfilePath(...segments: string[]): string | null
 *
 * Observable behavior exercised here:
 *   - resolveChromeProfileDir returns null when the Chrome base directory is missing.
 *   - resolveChromeProfileDir returns null when the base directory exists but no
 *     Preferences files are found (no Chrome profiles configured).
 *   - resolveChromeProfileDir picks the profile whose Preferences file has the
 *     most recently modified mtime (among "Default", "Profile 1", "Profile 2", ...).
 *   - resolveChromeProfileDir returns the sole profile when only one matches.
 *   - resolveChromeProfilePath returns null when no profile can be resolved.
 *   - resolveChromeProfilePath returns null when the target segment inside the
 *     resolved profile does not exist on disk.
 *   - resolveChromeProfilePath joins the chosen profile dir with all provided
 *     segments and returns the path when it exists.
 *
 * Boundary capture: N/A — this module makes ZERO outbound HTTP calls. Its only
 * system boundaries are the filesystem (fs.existsSync / fs.statSync) and `glob.sync`.
 * We stub all three and assert on the resolved path strings. `fetchCaptures` is
 * still asserted empty as a hard invariant.
 *
 * Note on overlap: cookie-reader, local-storage-reader, cache-storage-reader, and
 * permission-reader each exercise `resolveChromeProfileDir` / `resolveChromeProfilePath`
 * as a slice of their own coverage. This suite owns the module's exported surface
 * at its direct module boundary (no consumer in the loop) and sticks to behaviors
 * not already asserted by those suites (sole-profile happy path, multi-segment
 * joining, no-glob-call short-circuit when base is missing).
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// ── Inline electron stub ────────────────────────────────────────────────────
// chromeProfileResolver does `import { app } from 'electron'` and uses
// `app.getPath('home')` at module load. We stub it so tests stay hermetic.
// Inlined (not imported from ./electron-stubs) to match the convention used by
// cookie-reader / local-storage-reader / cache-storage-reader — those suites
// mock `better-sqlite3` and hit hoisting conflicts with stubElectron(); keeping
// the pattern identical here avoids surprise divergence across reader domains.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/mac-app-test'),
  },
}));

// ── Mock filesystem + glob boundaries ───────────────────────────────────────

const globSync = vi.hoisted(() => vi.fn<(pattern: string) => string[]>(() => []));
vi.mock('glob', () => ({ glob: { sync: globSync }, sync: globSync }));

const fsExistsSync = vi.hoisted(() => vi.fn<(p: string) => boolean>(() => false));
const fsStatSync = vi.hoisted(() =>
  vi.fn<(p: string) => { mtime: Date }>(() => ({ mtime: new Date(0) }))
);
vi.mock('fs', () => ({
  default: { existsSync: fsExistsSync, statSync: fsStatSync },
  existsSync: fsExistsSync,
  statSync: fsStatSync,
}));

// ── Suite ───────────────────────────────────────────────────────────────────

describe('chrome-profile-resolver blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    globSync.mockReset();
    fsExistsSync.mockReset();
    fsStatSync.mockReset();
    // Install fetch capture so the boundary invariant is enforced on every test.
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  describe('resolveChromeProfileDir — empty state', () => {
    it('returns null when the Chrome base directory does not exist', async () => {
      fsExistsSync.mockReturnValue(false);
      const { resolveChromeProfileDir } = await import('../../main/services/chromeProfileResolver');

      expect(resolveChromeProfileDir()).toBeNull();
      // Short-circuit: glob is never invoked when the base dir is absent.
      expect(globSync).not.toHaveBeenCalled();
      expect(fsStatSync).not.toHaveBeenCalled();
    });

    it('returns null when the base exists but no Preferences files are found', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue([]);
      const { resolveChromeProfileDir } = await import('../../main/services/chromeProfileResolver');

      expect(resolveChromeProfileDir()).toBeNull();
      expect(globSync).toHaveBeenCalledTimes(1);
      expect(fsStatSync).not.toHaveBeenCalled();
    });
  });

  describe('resolveChromeProfileDir — happy path', () => {
    it('returns the sole profile directory when only one Preferences file matches', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue([
        '/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default/Preferences',
      ]);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });

      const { resolveChromeProfileDir } = await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfileDir()).toBe(
        '/tmp/mac-app-test/Library/Application Support/Google/Chrome/Default'
      );
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
        return { mtime: new Date('2024-01-01T00:00:00Z') }; // Default
      });

      const { resolveChromeProfileDir } = await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfileDir()).toBe('/tmp/Chrome/Profile 1');
    });

    it('is deterministic: same inputs produce the same resolved profile', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue([
        '/tmp/Chrome/Default/Preferences',
        '/tmp/Chrome/Profile 1/Preferences',
      ]);
      fsStatSync.mockImplementation((p: string) => {
        if (p.includes('Profile 1')) return { mtime: new Date('2025-06-15T00:00:00Z') };
        return { mtime: new Date('2025-01-01T00:00:00Z') };
      });

      const { resolveChromeProfileDir } = await import('../../main/services/chromeProfileResolver');
      const first = resolveChromeProfileDir();
      const second = resolveChromeProfileDir();
      expect(first).toBe('/tmp/Chrome/Profile 1');
      expect(second).toBe(first);
    });
  });

  describe('resolveChromeProfilePath — empty/error state', () => {
    it('returns null when no Chrome profile can be resolved', async () => {
      fsExistsSync.mockReturnValue(false);
      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');

      expect(resolveChromeProfilePath('Cookies')).toBeNull();
    });

    it('returns null when the target file inside the resolved profile does not exist', async () => {
      // Chrome base + Preferences exist, but the requested target does not.
      fsExistsSync.mockImplementation((p: string) => !p.endsWith('Cookies'));
      globSync.mockReturnValue(['/tmp/Chrome/Default/Preferences']);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });

      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfilePath('Cookies')).toBeNull();
    });
  });

  describe('resolveChromeProfilePath — happy path', () => {
    it('returns the joined path when a single segment exists inside the chosen profile', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue(['/tmp/Chrome/Default/Preferences']);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });

      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfilePath('Cookies')).toBe('/tmp/Chrome/Default/Cookies');
    });

    it('joins multiple path segments onto the resolved profile directory', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue(['/tmp/Chrome/Profile 1/Preferences']);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });

      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfilePath('Local Storage', 'leveldb')).toBe(
        '/tmp/Chrome/Profile 1/Local Storage/leveldb'
      );
    });

    it('returns the profile directory itself when called with no segments', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue(['/tmp/Chrome/Default/Preferences']);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });

      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');
      expect(resolveChromeProfilePath()).toBe('/tmp/Chrome/Default');
    });
  });

  describe('boundary invariant (HTTP)', () => {
    it('makes zero outbound HTTP calls during resolveChromeProfileDir', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue(['/tmp/Chrome/Default/Preferences']);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });

      const { resolveChromeProfileDir } = await import('../../main/services/chromeProfileResolver');
      resolveChromeProfileDir();

      expect(fetchCaptures).toHaveLength(0);
    });

    it('makes zero outbound HTTP calls during resolveChromeProfilePath', async () => {
      fsExistsSync.mockReturnValue(true);
      globSync.mockReturnValue(['/tmp/Chrome/Default/Preferences']);
      fsStatSync.mockReturnValue({ mtime: new Date('2025-01-01T00:00:00Z') });

      const { resolveChromeProfilePath } =
        await import('../../main/services/chromeProfileResolver');
      resolveChromeProfilePath('Cookies');

      expect(fetchCaptures).toHaveLength(0);
    });
  });
});
