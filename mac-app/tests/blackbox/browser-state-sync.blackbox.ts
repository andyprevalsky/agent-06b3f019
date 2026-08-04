import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubAllElectron } from './electron-stubs';
import {
  fetchCaptures,
  clearFetchCaptures,
  installFetchCapture,
  type FetchCapture,
} from './fetch-capture';

// ── Stub native/electron modules at module load time ─────────────────────────
stubAllElectron();

// Stub the config module so browserStateSync's config.apiUrl resolves
// without loading the real electron-aware config (which would crash in jsdom).
vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'https://backend.test',
    supabase: { url: 'https://sb.test', anonKey: 'anon' },
    encryptionKey: 'test-key',
    isDev: true,
  },
}));

// Stub Crypto — the real impl calls node crypto which works in jsdom, but
// replacing it keeps envelopes deterministic. The return value is set in
// beforeEach (vi.resetAllMocks() clears factory impls).
vi.mock('../../main/base/crypto', () => ({
  Crypto: { encrypt: vi.fn() },
}));

// Mocks for the browser-side services. Each test overrides the return values
// via `vi.mocked(...).mockResolvedValueOnce(...)` for the scenario under test.
vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: vi.fn(),
  },
}));

vi.mock('../../main/services/atlasCredentialStore', () => ({
  AtlasCredentialStore: {
    getPassword: vi.fn(() => null),
  },
}));

vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: {
    getConnected: vi.fn(),
  },
}));

vi.mock('../../main/services/browserCookieReader', () => ({
  BrowserCookieReader: {
    getInstalledBrowsers: vi.fn(() => []),
    readCookies: vi.fn(async () => []),
  },
}));

vi.mock('../../main/services/browserPasswordReader', () => ({
  BrowserPasswordReader: {
    readAndEncryptPasswords: vi.fn(async () => []),
  },
}));

vi.mock('../../main/services/localStorageReader', () => ({
  LocalStorageReader: {
    readLocalStorage: vi.fn(async () => ({
      entries: [],
      byOrigin: {},
      hashes: {},
      entryCount: 0,
      originCount: 0,
    })),
  },
}));

vi.mock('../../main/services/indexedDBReader', () => ({
  IndexedDBReader: {
    readIndexedDB: vi.fn(async () => ({ origins: [], hashes: {} })),
  },
}));

vi.mock('../../main/services/cacheStorageReader', () => ({
  CacheStorageReader: {
    readCacheStorage: vi.fn(async () => ({ origins: [], hashes: {}, originCount: 0 })),
  },
}));

vi.mock('../../main/services/permissionReader', () => ({
  PermissionReader: {
    readPermissions: vi.fn(async () => ({ grants: [], grantCount: 0 })),
  },
}));

vi.mock('../../main/services/fingerprintReader', () => ({
  FingerprintReader: {
    collectFingerprint: vi.fn(async () => null),
  },
}));

vi.mock('../../main/services/batchUploader', () => ({
  BatchUploader: {
    uploadInBatches: vi.fn(async () => ({ success: true })),
  },
}));

// Import after all `vi.mock` calls (hoisted) — ensures the mocks are in place.
const { BrowserStateSync } = await import('../../main/services/browserStateSync');
const { Crypto } = await import('../../main/base/crypto');
const { AuthService } = await import('../../main/services/auth');
const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');
const { BrowserCookieReader } = await import('../../main/services/browserCookieReader');
const { LocalStorageReader } = await import('../../main/services/localStorageReader');
const { IndexedDBReader } = await import('../../main/services/indexedDBReader');
const { CacheStorageReader } = await import('../../main/services/cacheStorageReader');
const { PermissionReader } = await import('../../main/services/permissionReader');
const { BrowserPasswordReader } = await import('../../main/services/browserPasswordReader');
const { BatchUploader } = await import('../../main/services/batchUploader');
const { AtlasCredentialStore } = await import('../../main/services/atlasCredentialStore');
const { FingerprintReader } = await import('../../main/services/fingerprintReader');

// Upload endpoints the domain calls. These are the boundary contract.
const ENDPOINT_PATHS = {
  localStorage: '/api/integrations/localStorage/upload',
  indexedDB: '/api/integrations/indexedDB/upload',
  permissions: '/api/integrations/permissions/upload',
  cacheStorage: '/api/integrations/cacheStorage/upload',
  passwords: '/api/integrations/passwords/upload',
} as const;

const encodeJwtPart = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const impersonatedSession = {
  access_token: `${encodeJwtPart({ alg: 'HS256' })}.${encodeJwtPart({
    sub: 'target-user',
    act: { sub: 'operator-user' },
  })}.sig`,
  refresh_token: 'impersonated-refresh',
  expires_at: Date.now() + 3_600_000,
  user: { id: 'target-user' },
};

function okResponder() {
  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function installOkCapture(): () => void {
  return installFetchCapture({
    [ENDPOINT_PATHS.localStorage]: okResponder,
    [ENDPOINT_PATHS.indexedDB]: okResponder,
    [ENDPOINT_PATHS.permissions]: okResponder,
    [ENDPOINT_PATHS.cacheStorage]: okResponder,
    [ENDPOINT_PATHS.passwords]: okResponder,
  });
}

function installFailingCapture(): () => void {
  const fail = () =>
    new Response(JSON.stringify({ error: 'boom' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  return installFetchCapture({
    [ENDPOINT_PATHS.localStorage]: fail,
    [ENDPOINT_PATHS.indexedDB]: fail,
    [ENDPOINT_PATHS.permissions]: fail,
    [ENDPOINT_PATHS.cacheStorage]: fail,
    [ENDPOINT_PATHS.passwords]: fail,
  });
}

function capturesFor(path: string): FetchCapture[] {
  return fetchCaptures.filter((c) => c.url.includes(path));
}

describe('browser-state-sync domain', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    vi.resetAllMocks();

    // Restore deterministic Crypto.encrypt after resetAllMocks().
    vi.mocked(Crypto.encrypt).mockReturnValue({
      encrypted: 'ENCRYPTED',
      iv: 'IV',
      key: 'KEY',
    });

    // Default: authenticated session.
    vi.mocked(AuthService.getSession).mockResolvedValue({
      access_token: 'ACCESS_TOKEN',
      refresh_token: 'refresh',
      expires_at: Date.now() + 3_600_000,
      user: { id: 'user-1' },
    } as never);

    // Default: chrome connected, chrome installed.
    vi.mocked(IntegrationCache.getConnected).mockResolvedValue(new Set(['chrome']));
    vi.mocked(BrowserCookieReader.getInstalledBrowsers).mockReturnValue([
      {
        type: 'chrome',
        name: 'Google Chrome',
        cookiePathPattern: '/tmp/chrome/Cookies',
        keychainEntry: 'Chrome Safe Storage',
        keychainAccount: 'Chrome',
        needsManualPassword: false,
        isInstalled: true,
        resolvedCookiePath: '/tmp/chrome/Cookies',
      },
    ] as never);
    vi.mocked(AtlasCredentialStore.getPassword).mockReturnValue(null);
    vi.mocked(BrowserCookieReader.readCookies).mockResolvedValue([] as never);
    vi.mocked(BrowserPasswordReader.readAndEncryptPasswords).mockResolvedValue([] as never);
    vi.mocked(FingerprintReader.collectFingerprint).mockResolvedValue(null);
    vi.mocked(BatchUploader.uploadInBatches).mockResolvedValue({ success: true } as never);

    // Reader defaults: empty data.
    vi.mocked(LocalStorageReader.readLocalStorage).mockResolvedValue({
      entries: [],
      byOrigin: {},
      hashes: {},
      entryCount: 0,
      originCount: 0,
    });
    vi.mocked(IndexedDBReader.readIndexedDB).mockResolvedValue({ origins: [], hashes: {} });
    vi.mocked(CacheStorageReader.readCacheStorage).mockResolvedValue({
      origins: [],
      hashes: {},
      originCount: 0,
    });
    vi.mocked(PermissionReader.readPermissions).mockResolvedValue({
      grants: [],
      grantCount: 0,
    } as never);
  });

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  describe('sync() — full browser state sync', () => {
    it('happy path: reads all sources and uploads each to the correct endpoint', async () => {
      // Chrome has localStorage, indexedDB, permissions, cacheStorage.
      vi.mocked(LocalStorageReader.readLocalStorage).mockResolvedValueOnce({
        entries: [{ origin: 'https://a.test', key: 'k', value: 'v' }],
        byOrigin: { 'https://a.test': [{ key: 'k', value: 'v' }] },
        hashes: { 'https://a.test': 'h1' },
        entryCount: 1,
        originCount: 1,
      });
      vi.mocked(IndexedDBReader.readIndexedDB).mockResolvedValue({
        origins: [{ origin: 'https://amazon.com', databases: [] }],
        hashes: { 'https://amazon.com': 'h2' },
      });
      vi.mocked(PermissionReader.readPermissions).mockResolvedValueOnce({
        grants: [
          {
            origin: 'https://b.test',
            permission: 'geolocation',
            setting: 'allow',
            lastModified: 0,
          },
        ],
        grantCount: 1,
      } as never);
      vi.mocked(CacheStorageReader.readCacheStorage).mockResolvedValueOnce({
        origins: [{ origin: 'https://c.test', caches: [] }],
        hashes: { 'https://c.test': 'h3' },
        originCount: 1,
      });
      vi.mocked(BrowserCookieReader.readCookies).mockResolvedValueOnce([
        { name: 'c', value: 'v', domain: 'a.test' } as never,
      ]);
      vi.mocked(BrowserPasswordReader.readAndEncryptPasswords).mockResolvedValueOnce([
        {
          origin: 'https://a.test',
          username: 'u',
          encryptedPassword: 'EP',
          dateLastUsed: 1,
          dateCreated: 0,
          browserSource: 'chrome',
        },
      ]);

      restoreFetch = installOkCapture();
      await BrowserStateSync.sync();

      // One upload per data type (cookies go via BatchUploader mock — not fetched).
      expect(capturesFor(ENDPOINT_PATHS.localStorage)).toHaveLength(1);
      expect(capturesFor(ENDPOINT_PATHS.indexedDB)).toHaveLength(1);
      expect(capturesFor(ENDPOINT_PATHS.permissions)).toHaveLength(1);
      expect(capturesFor(ENDPOINT_PATHS.cacheStorage)).toHaveLength(1);
      expect(capturesFor(ENDPOINT_PATHS.passwords)).toHaveLength(1);

      // All uploads use POST + Authorization bearer.
      for (const cap of fetchCaptures) {
        expect(cap.method).toBe('POST');
        expect(cap.headers['authorization']).toBe('Bearer ACCESS_TOKEN');
      }

      // Cookie uploads go through BatchUploader (no direct fetch expected here).
      expect(BatchUploader.uploadInBatches).toHaveBeenCalledWith(
        'chrome',
        expect.any(Array),
        'ACCESS_TOKEN',
        null
      );
    });

    it('empty state: when no browser integrations connected, uploads nothing', async () => {
      vi.mocked(IntegrationCache.getConnected).mockResolvedValueOnce(new Set());

      restoreFetch = installOkCapture();
      await BrowserStateSync.sync();

      expect(fetchCaptures).toHaveLength(0);
      expect(BatchUploader.uploadInBatches).not.toHaveBeenCalled();
      expect(LocalStorageReader.readLocalStorage).not.toHaveBeenCalled();
    });

    it('empty state: when unauthenticated, no readers run and no uploads happen', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValueOnce(null);

      restoreFetch = installOkCapture();
      await BrowserStateSync.sync();

      expect(fetchCaptures).toHaveLength(0);
      expect(IntegrationCache.getConnected).not.toHaveBeenCalled();
      expect(LocalStorageReader.readLocalStorage).not.toHaveBeenCalled();
    });

    it('empty state: chrome connected but readers return empty data → no uploads', async () => {
      // Default mocks already return empty. Chrome IS connected.
      restoreFetch = installOkCapture();
      await BrowserStateSync.sync();

      // No endpoint should be hit because each reader returned empty.
      expect(capturesFor(ENDPOINT_PATHS.localStorage)).toHaveLength(0);
      expect(capturesFor(ENDPOINT_PATHS.indexedDB)).toHaveLength(0);
      expect(capturesFor(ENDPOINT_PATHS.permissions)).toHaveLength(0);
      expect(capturesFor(ENDPOINT_PATHS.cacheStorage)).toHaveLength(0);
      expect(capturesFor(ENDPOINT_PATHS.passwords)).toHaveLength(0);
    });

    it('skips atlas when atlas credential is missing', async () => {
      vi.mocked(IntegrationCache.getConnected).mockResolvedValueOnce(new Set(['atlas']));
      vi.mocked(BrowserCookieReader.getInstalledBrowsers).mockReturnValueOnce([
        {
          type: 'atlas',
          name: 'Atlas',
          cookiePathPattern: '/tmp/atlas/Cookies',
          keychainEntry: 'ChatGPT Safe Storage',
          keychainAccount: 'ChatGPT',
          needsManualPassword: true,
          isInstalled: true,
          resolvedCookiePath: '/tmp/atlas/Cookies',
        },
      ] as never);
      // Atlas password not stored → should be filtered out.
      vi.mocked(AtlasCredentialStore.getPassword).mockReturnValueOnce(null);

      restoreFetch = installOkCapture();
      await BrowserStateSync.sync();

      expect(BrowserCookieReader.readCookies).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('non-chrome browser: only cookies are read, chrome-only readers are skipped', async () => {
      vi.mocked(IntegrationCache.getConnected).mockResolvedValueOnce(new Set(['edge']));
      vi.mocked(BrowserCookieReader.getInstalledBrowsers).mockReturnValueOnce([
        {
          type: 'edge',
          name: 'Microsoft Edge',
          cookiePathPattern: '/tmp/edge/Cookies',
          keychainEntry: 'Microsoft Edge Safe Storage',
          keychainAccount: 'Microsoft Edge',
          needsManualPassword: false,
          isInstalled: true,
          resolvedCookiePath: '/tmp/edge/Cookies',
        },
      ] as never);
      vi.mocked(BrowserCookieReader.readCookies).mockResolvedValueOnce([
        { name: 'c', value: 'v', domain: 'edge.test' } as never,
      ]);

      restoreFetch = installOkCapture();
      await BrowserStateSync.sync();

      expect(BatchUploader.uploadInBatches).toHaveBeenCalledWith(
        'edge',
        expect.any(Array),
        'ACCESS_TOKEN',
        null
      );
      // Chrome-only readers must NOT run when only edge is connected.
      expect(LocalStorageReader.readLocalStorage).not.toHaveBeenCalled();
      expect(IndexedDBReader.readIndexedDB).not.toHaveBeenCalled();
      expect(PermissionReader.readPermissions).not.toHaveBeenCalled();
      expect(CacheStorageReader.readCacheStorage).not.toHaveBeenCalled();
    });

    it('error state: when reader throws, sync continues without crashing and other uploads proceed', async () => {
      // localStorage reader crashes — sync should still upload others.
      vi.mocked(LocalStorageReader.readLocalStorage).mockRejectedValueOnce(new Error('disk IO'));
      vi.mocked(CacheStorageReader.readCacheStorage).mockResolvedValueOnce({
        origins: [{ origin: 'https://c.test', caches: [] }],
        hashes: { 'https://c.test': 'h' },
        originCount: 1,
      });

      restoreFetch = installOkCapture();

      await expect(BrowserStateSync.sync()).resolves.toBeUndefined();

      // localStorage upload never happened (reader failed).
      expect(capturesFor(ENDPOINT_PATHS.localStorage)).toHaveLength(0);
      // cacheStorage upload DID happen.
      expect(capturesFor(ENDPOINT_PATHS.cacheStorage)).toHaveLength(1);
    });
  });

  describe('uploadLocalStorageInBatches (via sync path) — retry + failure behavior', () => {
    it('error state: 500 response retries up to MAX_RETRIES (3 attempts total per batch)', async () => {
      vi.mocked(LocalStorageReader.readLocalStorage).mockResolvedValueOnce({
        entries: [{ origin: 'https://a.test', key: 'k', value: 'v' }],
        byOrigin: { 'https://a.test': [{ key: 'k', value: 'v' }] },
        hashes: { 'https://a.test': 'h' },
        entryCount: 1,
        originCount: 1,
      });

      restoreFetch = installFailingCapture();

      await BrowserStateSync.sync();

      // 3 attempts for the single localStorage batch.
      const lsCaptures = capturesFor(ENDPOINT_PATHS.localStorage);
      expect(lsCaptures).toHaveLength(3);
      // All attempts must target the same endpoint, same method, same auth.
      for (const cap of lsCaptures) {
        expect(cap.method).toBe('POST');
        expect(cap.responseStatus).toBe(500);
        expect(cap.headers['authorization']).toBe('Bearer ACCESS_TOKEN');
      }
    });
  });

  describe('syncBrowser() — per-browser full sync', () => {
    it('returns error when unauthenticated', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValueOnce(null);

      restoreFetch = installOkCapture();
      const result = await BrowserStateSync.syncBrowser('chrome');

      expect(result).toEqual({ success: false, message: 'Not authenticated' });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('chrome: uploads cookies (via BatchUploader) + fingerprint, plus any chrome data', async () => {
      vi.mocked(BrowserCookieReader.readCookies).mockResolvedValueOnce([
        { name: 'c', value: 'v', domain: 'a.test' } as never,
      ]);
      vi.mocked(FingerprintReader.collectFingerprint).mockResolvedValueOnce({
        userAgent: 'ua',
      } as never);

      restoreFetch = installOkCapture();
      const result = await BrowserStateSync.syncBrowser('chrome');

      expect(result.success).toBe(true);
      // Cookies + fingerprint go through BatchUploader.
      expect(BatchUploader.uploadInBatches).toHaveBeenCalledWith(
        'chrome',
        expect.any(Array),
        'ACCESS_TOKEN',
        null
      );
      expect(BatchUploader.uploadInBatches).toHaveBeenCalledWith(
        'browser_fingerprint',
        expect.objectContaining({ userAgent: 'ua' }),
        'ACCESS_TOKEN',
        null
      );
    });

    it('non-chrome: does NOT read localStorage/indexedDB/permissions/cacheStorage', async () => {
      vi.mocked(BrowserCookieReader.readCookies).mockResolvedValueOnce([
        { name: 'c', value: 'v', domain: 'edge.test' } as never,
      ]);

      restoreFetch = installOkCapture();
      const result = await BrowserStateSync.syncBrowser('edge');

      expect(result.success).toBe(true);
      expect(LocalStorageReader.readLocalStorage).not.toHaveBeenCalled();
      expect(IndexedDBReader.readIndexedDB).not.toHaveBeenCalled();
      expect(PermissionReader.readPermissions).not.toHaveBeenCalled();
      expect(CacheStorageReader.readCacheStorage).not.toHaveBeenCalled();
    });

    it('empty state: no cookies, no fingerprint, no chrome data → returns no-op success', async () => {
      vi.mocked(BrowserCookieReader.readCookies).mockResolvedValueOnce([] as never);
      vi.mocked(FingerprintReader.collectFingerprint).mockResolvedValueOnce(null);

      restoreFetch = installOkCapture();
      const result = await BrowserStateSync.syncBrowser('edge');

      expect(result).toEqual({ success: true, message: 'No data to sync' });
      expect(fetchCaptures).toHaveLength(0);
      expect(BatchUploader.uploadInBatches).not.toHaveBeenCalled();
    });

    it('never reads or uploads local browser state into an impersonated account', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(impersonatedSession as never);

      await BrowserStateSync.sync();

      expect(IntegrationCache.getConnected).not.toHaveBeenCalled();
      expect(BrowserCookieReader.readCookies).not.toHaveBeenCalled();
      expect(LocalStorageReader.readLocalStorage).not.toHaveBeenCalled();
      expect(BatchUploader.uploadInBatches).not.toHaveBeenCalled();
    });
  });

  describe('syncBrowserPasswordsOnly() — password-only sync', () => {
    it('returns error when unauthenticated', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValueOnce(null);

      restoreFetch = installOkCapture();
      const result = await BrowserStateSync.syncBrowserPasswordsOnly('chrome');

      expect(result).toEqual({ success: false, message: 'Not authenticated' });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('rejects unsupported browsers (safari) with clear message', async () => {
      restoreFetch = installOkCapture();
      const result = await BrowserStateSync.syncBrowserPasswordsOnly('safari');

      expect(result.success).toBe(false);
      expect(result.message).toContain('not supported');
      expect(fetchCaptures).toHaveLength(0);
      expect(BrowserPasswordReader.readAndEncryptPasswords).not.toHaveBeenCalled();
    });

    it('atlas without keychainPassword is rejected before touching reader', async () => {
      restoreFetch = installOkCapture();
      const result = await BrowserStateSync.syncBrowserPasswordsOnly('atlas');

      expect(result.success).toBe(false);
      expect(result.message).toContain('keychain');
      expect(BrowserPasswordReader.readAndEncryptPasswords).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('happy path: uploads encrypted passwords to /api/integrations/passwords/upload', async () => {
      vi.mocked(BrowserPasswordReader.readAndEncryptPasswords).mockResolvedValueOnce([
        {
          origin: 'https://a.test',
          username: 'u',
          encryptedPassword: 'EP',
          dateLastUsed: 1,
          dateCreated: 0,
          browserSource: 'chrome',
        },
      ]);

      restoreFetch = installOkCapture();
      const result = await BrowserStateSync.syncBrowserPasswordsOnly('chrome');

      expect(result.success).toBe(true);
      const caps = capturesFor(ENDPOINT_PATHS.passwords);
      expect(caps).toHaveLength(1);
      expect(caps[0].method).toBe('POST');
      expect(caps[0].headers['authorization']).toBe('Bearer ACCESS_TOKEN');
      // FormData body was set on request — present and non-empty.
      expect(caps[0].body ?? '').not.toBe('');
    });

    it('empty state: reader returns [] → no upload, no-op success', async () => {
      vi.mocked(BrowserPasswordReader.readAndEncryptPasswords).mockResolvedValueOnce([] as never);

      restoreFetch = installOkCapture();
      const result = await BrowserStateSync.syncBrowserPasswordsOnly('chrome');

      expect(result).toEqual({ success: true, message: 'No passwords to sync' });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('error state: reader throws → returns failure with message, no upload attempted', async () => {
      vi.mocked(BrowserPasswordReader.readAndEncryptPasswords).mockRejectedValueOnce(
        new Error('keychain denied')
      );

      restoreFetch = installOkCapture();
      const result = await BrowserStateSync.syncBrowserPasswordsOnly('chrome');

      expect(result.success).toBe(false);
      expect(result.message).toContain('keychain denied');
      expect(fetchCaptures).toHaveLength(0);
    });

    it('error state: upload 500 → retries not applicable for passwords path → returns failure', async () => {
      vi.mocked(BrowserPasswordReader.readAndEncryptPasswords).mockResolvedValueOnce([
        {
          origin: 'https://a.test',
          username: 'u',
          encryptedPassword: 'EP',
          dateLastUsed: 1,
          dateCreated: 0,
          browserSource: 'chrome',
        },
      ]);

      restoreFetch = installFailingCapture();
      const result = await BrowserStateSync.syncBrowserPasswordsOnly('chrome');

      expect(result.success).toBe(false);
      expect(result.message).toContain('500');
      // Passwords path does NOT retry — exactly one attempt.
      expect(capturesFor(ENDPOINT_PATHS.passwords)).toHaveLength(1);
    });
  });
});
