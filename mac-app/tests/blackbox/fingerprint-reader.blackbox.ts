/**
 * fingerprint-reader domain blackbox
 *
 * Surface under test:
 *   - main/services/fingerprintReader.ts  (FingerprintReader.collectFingerprint: Chrome discovery → puppeteer launch → evaluate → cleanup)
 *   - shared/types/ipc.ts                 (FingerprintData shape — consumed, not tested directly)
 *
 * Observable behavior exercised here:
 *   - collectFingerprint returns null when no Chrome binary exists on disk (does not
 *     launch puppeteer, does not create a temp user-data-dir).
 *   - collectFingerprint launches puppeteer with executablePath pointing at the
 *     first Chrome found, a unique --user-data-dir arg, and the off-screen/
 *     minimal-window flag set the service depends on.
 *   - collectFingerprint navigates to https://example.com and returns the
 *     evaluated fingerprint payload verbatim.
 *   - collectFingerprint returns null when puppeteer.launch throws (Chrome missing
 *     required entitlements, sandbox failure, etc.) — error path must not propagate.
 *   - collectFingerprint returns null when page.goto or page.evaluate throws —
 *     still closes the browser and removes the temp dir (finally block).
 *
 * Boundary capture: the domain's only HTTP boundary is the `page.goto(example.com)`
 * navigation, which is driven by puppeteer-core inside a real Chrome process — NOT
 * by Node's `fetch`. The in-process fetch-capture harness cannot observe it. We
 * stub puppeteer and assert on `page.goto` call params (URL, options) as the
 * boundary contract. `fetchCaptures` is still asserted empty as a hard invariant
 * to catch any future regression that introduces Node-level HTTP calls.
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks, broader-suite verification.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

// Stub electron inline — the service imports `app` at module load time to resolve
// the user's home directory. Importing from ./electron-stubs would drag in the
// file's top-level `vi.mock` side effects and isn't needed here.
vi.mock('electron', () => ({
  app: {
    name: '',
    isPackaged: false,
    getPath: vi.fn((key: string) => {
      if (key === 'home') return '/tmp/mac-app-home';
      return '/tmp/mac-app-test';
    }),
    getName: vi.fn(() => 'rose-desktop-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
  },
}));

// ── Mock the system boundaries FingerprintReader reaches across ──────────────

// `fs` — existsSync drives Chrome discovery; mkdirSync/rmSync drive temp-dir lifecycle.
const fsExistsSync = vi.hoisted(() => vi.fn<(p: string) => boolean>(() => false));
const fsMkdirSync = vi.hoisted(() => vi.fn<(p: string, opts?: unknown) => void>(() => undefined));
const fsRmSync = vi.hoisted(() => vi.fn<(p: string, opts?: unknown) => void>(() => undefined));
vi.mock('fs', () => ({
  default: {
    existsSync: fsExistsSync,
    mkdirSync: fsMkdirSync,
    rmSync: fsRmSync,
  },
  existsSync: fsExistsSync,
  mkdirSync: fsMkdirSync,
  rmSync: fsRmSync,
}));

// `os` — tmpdir drives the temp user-data-dir path.
const osTmpdir = vi.hoisted(() => vi.fn<() => string>(() => '/tmp/mac-app-tmp'));
vi.mock('os', () => ({
  default: { tmpdir: osTmpdir },
  tmpdir: osTmpdir,
}));

// `puppeteer-core` — the launch/evaluate boundary. Tests install per-case behavior
// via the hoisted mocks below.
interface PuppeteerPageStub {
  goto: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
}
interface PuppeteerBrowserStub {
  newPage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}
const puppeteerLaunch = vi.hoisted(() => vi.fn());
vi.mock('puppeteer-core', () => ({
  default: { launch: puppeteerLaunch },
  launch: puppeteerLaunch,
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const STABLE_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Build a FingerprintData-shaped object for tests that install a happy-path
 * evaluate() return value. We don't assert every field — the contract is that
 * whatever page.evaluate returns is returned verbatim from collectFingerprint.
 */
function makeFingerprint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    navigator: {
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      platform: 'MacIntel',
      language: 'en-US',
      languages: ['en-US', 'en'],
      hardwareConcurrency: 10,
      deviceMemory: 16,
      maxTouchPoints: 0,
      vendor: 'Google Inc.',
      doNotTrack: null,
    },
    userAgentData: {
      brands: [{ brand: 'Chromium', version: '122' }],
      mobile: false,
      platform: 'macOS',
      platformVersion: '14.2.1',
      architecture: 'arm',
      bitness: '64',
      model: '',
      fullVersionList: [{ brand: 'Chromium', version: '122.0.6261.69' }],
    },
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1055,
      colorDepth: 24,
      pixelDepth: 24,
      devicePixelRatio: 2,
    },
    viewport: { innerWidth: 1, innerHeight: 1, outerWidth: 1, outerHeight: 1 },
    connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
    webgl: { vendor: 'Apple Inc.', renderer: 'Apple M1' },
    canvas: { hash: 'data:image/png;base64,...' },
    audio: { hash: '0,1,2,3' },
    timezone: 'America/Chicago',
    timezoneOffset: 360,
    fonts: ['Arial', 'Helvetica'],
    plugins: [],
    collectedAt: '2026-04-18T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Install a happy-path puppeteer that returns `fingerprint` from page.evaluate.
 * Returns the page/browser stubs so tests can assert on call params.
 */
function installPuppeteerOk(fingerprint: Record<string, unknown> = makeFingerprint()): {
  browser: PuppeteerBrowserStub;
  page: PuppeteerPageStub;
} {
  const page: PuppeteerPageStub = {
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => fingerprint),
  };
  const browser: PuppeteerBrowserStub = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  puppeteerLaunch.mockResolvedValue(browser);
  return { browser, page };
}

/**
 * Make fs.existsSync report that Chrome is installed at the default path (and
 * only at that path — the other candidate paths return false).
 */
function installChromePresent(): void {
  fsExistsSync.mockImplementation((p: string) => p === STABLE_CHROME_PATH);
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('fingerprint-reader blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    fsExistsSync.mockReset();
    fsMkdirSync.mockReset();
    fsRmSync.mockReset();
    osTmpdir.mockReset();
    osTmpdir.mockReturnValue('/tmp/mac-app-tmp');
    puppeteerLaunch.mockReset();
    // Default Date.now so the temp-dir name is deterministic across tests that
    // assert on the path. Individual tests can override.
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    // Capture any accidental outbound fetches so the boundary invariant is enforced.
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    vi.restoreAllMocks();
  });

  describe('collectFingerprint — Chrome discovery', () => {
    it('returns null when no Chrome binary exists at any known path', async () => {
      fsExistsSync.mockReturnValue(false);
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      const result = await FingerprintReader.collectFingerprint();

      expect(result).toBeNull();
      expect(puppeteerLaunch).not.toHaveBeenCalled();
      expect(fsMkdirSync).not.toHaveBeenCalled();
      expect(fsRmSync).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('falls through the candidate path list in order and picks the first match', async () => {
      const canaryPath =
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary';
      // Stable Chrome missing, Canary present.
      fsExistsSync.mockImplementation((p: string) => p === canaryPath);
      installPuppeteerOk();
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      await FingerprintReader.collectFingerprint();

      expect(puppeteerLaunch).toHaveBeenCalledTimes(1);
      const [launchArgs] = puppeteerLaunch.mock.calls[0];
      expect(launchArgs.executablePath).toBe(canaryPath);
    });
  });

  describe('collectFingerprint — happy path', () => {
    it('returns the exact fingerprint payload produced by page.evaluate', async () => {
      installChromePresent();
      const fp = makeFingerprint({ timezone: 'America/New_York' });
      installPuppeteerOk(fp);
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      const result = await FingerprintReader.collectFingerprint();

      // The service returns the evaluate() payload verbatim — no transformation.
      expect(result).toEqual(fp);
      expect(fetchCaptures).toHaveLength(0);
    });

    it('creates a unique temp user-data-dir under os.tmpdir and passes it to puppeteer', async () => {
      installChromePresent();
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      osTmpdir.mockReturnValue('/var/folders/tmpXYZ');
      installPuppeteerOk();
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      await FingerprintReader.collectFingerprint();

      const expectedDir = '/var/folders/tmpXYZ/rose-fingerprint-1700000000000';
      expect(fsMkdirSync).toHaveBeenCalledWith(expectedDir, { recursive: true });

      const [launchArgs] = puppeteerLaunch.mock.calls[0];
      expect(launchArgs.args).toContain(`--user-data-dir=${expectedDir}`);
    });

    it('passes the minimal-window + off-screen launch flags puppeteer needs for a hidden capture', async () => {
      installChromePresent();
      installPuppeteerOk();
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      await FingerprintReader.collectFingerprint();

      const [launchArgs] = puppeteerLaunch.mock.calls[0];
      expect(launchArgs.executablePath).toBe(STABLE_CHROME_PATH);
      // Headful is required to read real screen dimensions, not a typo.
      expect(launchArgs.headless).toBe(false);
      // These are the exact flags the service relies on to keep the window out of the user's way.
      expect(launchArgs.args).toEqual(
        expect.arrayContaining([
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-sync',
          '--window-position=-10000,-10000',
          '--window-size=1,1',
          '--start-minimized',
        ])
      );
    });

    it('navigates to https://example.com with a domcontentloaded wait condition (boundary contract)', async () => {
      installChromePresent();
      const { page } = installPuppeteerOk();
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      await FingerprintReader.collectFingerprint();

      expect(page.goto).toHaveBeenCalledTimes(1);
      const [url, options] = page.goto.mock.calls[0];
      expect(url).toBe('https://example.com');
      expect(options).toMatchObject({ waitUntil: 'domcontentloaded', timeout: 10000 });
    });

    it('closes the browser and removes the temp dir after success', async () => {
      installChromePresent();
      vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
      const { browser } = installPuppeteerOk();
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      await FingerprintReader.collectFingerprint();

      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(fsRmSync).toHaveBeenCalledTimes(1);
      const [rmPath, rmOpts] = fsRmSync.mock.calls[0];
      expect(rmPath).toContain('rose-fingerprint-');
      expect(rmOpts).toMatchObject({ recursive: true, force: true });
    });
  });

  describe('collectFingerprint — error state', () => {
    it('returns null when puppeteer.launch throws (does not propagate)', async () => {
      installChromePresent();
      puppeteerLaunch.mockRejectedValue(new Error('sandbox init failed'));
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      const result = await FingerprintReader.collectFingerprint();

      expect(result).toBeNull();
      // Temp dir was created before launch — cleanup must still run.
      expect(fsMkdirSync).toHaveBeenCalledTimes(1);
      expect(fsRmSync).toHaveBeenCalledTimes(1);
      expect(fetchCaptures).toHaveLength(0);
    });

    it('returns null when page.goto throws and still closes browser + cleans temp dir', async () => {
      installChromePresent();
      const page: PuppeteerPageStub = {
        goto: vi.fn(async () => {
          throw new Error('net::ERR_INTERNET_DISCONNECTED');
        }),
        evaluate: vi.fn(),
      };
      const browser: PuppeteerBrowserStub = {
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => undefined),
      };
      puppeteerLaunch.mockResolvedValue(browser);
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      const result = await FingerprintReader.collectFingerprint();

      expect(result).toBeNull();
      expect(page.evaluate).not.toHaveBeenCalled();
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(fsRmSync).toHaveBeenCalledTimes(1);
    });

    it('returns null when page.evaluate throws (fingerprint callback crashes)', async () => {
      installChromePresent();
      const page: PuppeteerPageStub = {
        goto: vi.fn(async () => undefined),
        evaluate: vi.fn(async () => {
          throw new Error('evaluate: execution context was destroyed');
        }),
      };
      const browser: PuppeteerBrowserStub = {
        newPage: vi.fn(async () => page),
        close: vi.fn(async () => undefined),
      };
      puppeteerLaunch.mockResolvedValue(browser);
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      const result = await FingerprintReader.collectFingerprint();

      expect(result).toBeNull();
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(fsRmSync).toHaveBeenCalledTimes(1);
    });

    it('swallows cleanup errors (fsRmSync throws) without masking a successful fingerprint', async () => {
      installChromePresent();
      const fp = makeFingerprint();
      installPuppeteerOk(fp);
      fsRmSync.mockImplementation(() => {
        throw new Error('EBUSY: resource busy');
      });
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      // The cleanup catch-all inside the finally block swallows this.
      const result = await FingerprintReader.collectFingerprint();
      expect(result).toEqual(fp);
    });
  });

  describe('boundary invariant (HTTP)', () => {
    it('makes zero Node-side outbound fetch calls during collectFingerprint', async () => {
      installChromePresent();
      installPuppeteerOk();
      const { FingerprintReader } = await import('../../main/services/fingerprintReader');

      await FingerprintReader.collectFingerprint();

      // The only network I/O is puppeteer's page.goto(example.com), which goes
      // through Chrome, not through Node fetch. Our fetch-capture harness must
      // see no calls.
      expect(fetchCaptures).toHaveLength(0);
    });
  });
});
