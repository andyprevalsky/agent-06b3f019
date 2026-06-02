import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { stubAllElectron } from './electron-stubs';
import {
  fetchCaptures,
  clearFetchCaptures,
  installFetchCapture,
  type MockResponder,
} from './fetch-capture';
import type { AuthSession, CookieData } from '../../shared/types/ipc';

stubAllElectron();

// Mock main/base/config so the real module's top-level dotenv/throw logic
// never runs in the jsdom test environment.
vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'https://backend.test',
    supabase: {
      url: 'https://supabase.test',
      anonKey: 'anon-key-test',
    },
    encryptionKey: 'encryption-key-test',
    isDev: true,
  },
}));

// Mock main/base/logger (imported transitively by IntegrationCache) to avoid
// fs/stream setup during tests.
vi.mock('../../main/base/logger', () => ({
  logConsole: vi.fn(),
  logConsoleError: vi.fn(),
}));

// Mock the collaborator services cookieSync coordinates over. We keep
// BatchUploader + Uploader real so the fetch-capture wrapper records the
// outbound /api/integrations/cookies/upload call through the real encrypt →
// upload path.
vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: vi.fn<() => Promise<AuthSession | null>>(),
    setSession: vi.fn(),
    clearSession: vi.fn(),
  },
}));

vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: {
    isConnected: vi.fn<(name: string) => Promise<boolean>>(),
    getConnected: vi.fn(),
    getIntegration: vi.fn(),
    invalidate: vi.fn(),
  },
}));

vi.mock('../../main/services/browserCookieReader', () => ({
  BrowserCookieReader: {
    readCookies: vi.fn<(browser: string) => Promise<CookieData[]>>(),
  },
}));

import { CookieSync } from '../../main/services/cookieSync';
import { AuthService } from '../../main/services/auth';
import { IntegrationCache } from '../../main/services/sync/IntegrationCache';
import { BrowserCookieReader } from '../../main/services/browserCookieReader';

const SESSION: AuthSession = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_at: Date.now() + 60 * 60 * 1000,
  user: { id: 'user-1' },
};

const makeCookie = (overrides: Partial<CookieData> = {}): CookieData => ({
  host_key: '.example.com',
  name: 'session',
  value: 'abc123',
  path: '/',
  expires_utc: 0,
  is_secure: true,
  is_httponly: true,
  creation_utc: 0,
  top_frame_site_key: '',
  last_access_utc: 0,
  has_expires: false,
  is_persistent: true,
  priority: 1,
  samesite: 0,
  source_scheme: 2,
  source_port: 443,
  last_update_utc: 0,
  ...overrides,
});

function decryptPayload(encrypted: string, iv: string, key: string): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(key, 'hex'),
    Buffer.from(iv, 'hex')
  );
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString(
    'utf8'
  );
}

async function parseFormData(
  rawBody: string,
  contentType: string | undefined
): Promise<Record<string, string>> {
  const response = new Response(rawBody, {
    headers: contentType ? { 'content-type': contentType } : {},
  });
  const form = await response.formData();
  return Object.fromEntries(Array.from(form.entries()).map(([k, v]) => [k, String(v)]));
}

async function decryptCookieUploadPayload(captureIndex = 0): Promise<unknown> {
  const req = fetchCaptures[captureIndex];
  if (req.body === null) {
    throw new Error('Expected multipart body to be captured');
  }
  const form = await parseFormData(req.body, req.headers['content-type']);
  return JSON.parse(decryptPayload(form.data, form.iv, form.key));
}

describe('cookie-sync blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    vi.mocked(AuthService.getSession).mockReset();
    vi.mocked(IntegrationCache.isConnected).mockReset();
    vi.mocked(BrowserCookieReader.readCookies).mockReset();
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  const installUploadFetch = (responder: MockResponder): void => {
    restoreFetch = installFetchCapture({
      '/api/integrations/cookies/upload': responder,
    });
  };

  describe('happy path', () => {
    it('reads cookies, encrypts, and POSTs to the cookies upload endpoint', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      vi.mocked(IntegrationCache.isConnected).mockResolvedValue(true);
      vi.mocked(BrowserCookieReader.readCookies).mockResolvedValue([
        makeCookie({ name: 'a', value: 'v1' }),
        makeCookie({ name: 'b', value: 'v2' }),
      ]);
      installUploadFetch(
        () =>
          new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
      );

      await CookieSync.sync();

      expect(fetchCaptures).toHaveLength(1);
      const req = fetchCaptures[0];
      expect(req.url).toBe('https://backend.test/api/integrations/cookies/upload');
      expect(req.method).toBe('POST');
      expect(req.headers.authorization).toBe(`Bearer ${SESSION.access_token}`);
      expect(req.responseStatus).toBe(200);
      // Multipart body carries browser=chrome + encrypted payload fields.
      expect(req.body).toContain('name="browser"');
      expect(req.body).toContain('chrome');
      expect(req.body).toContain('name="data"');
      expect(req.body).toContain('name="iv"');
      expect(req.body).toContain('name="key"');
    });

    it('preserves browserProfile in the encrypted cookie upload payload', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      vi.mocked(IntegrationCache.isConnected).mockResolvedValue(true);
      vi.mocked(BrowserCookieReader.readCookies).mockResolvedValue([
        makeCookie({ name: 'default-session', value: 'v1', browserProfile: 'Default' }),
        makeCookie({ name: 'profile-session', value: 'v2', browserProfile: 'Profile 1' }),
      ]);
      installUploadFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));

      await CookieSync.sync();

      const payload = await decryptCookieUploadPayload();
      expect(payload).toEqual([
        expect.objectContaining({
          name: 'default-session',
          value: 'v1',
          browserProfile: 'Default',
        }),
        expect.objectContaining({
          name: 'profile-session',
          value: 'v2',
          browserProfile: 'Profile 1',
        }),
      ]);
    });

    it('uploads the current reader snapshot without carrying deleted profile cookies forward', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      vi.mocked(IntegrationCache.isConnected).mockResolvedValue(true);
      vi.mocked(BrowserCookieReader.readCookies)
        .mockResolvedValueOnce([
          makeCookie({ name: 'stale', value: 'old', browserProfile: 'Default' }),
          makeCookie({ name: 'kept', value: 'fresh', browserProfile: 'Default' }),
        ])
        .mockResolvedValueOnce([
          makeCookie({ name: 'kept', value: 'fresh', browserProfile: 'Default' }),
        ]);
      installUploadFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));

      await CookieSync.sync();
      await CookieSync.sync();

      expect(fetchCaptures).toHaveLength(2);
      const firstPayload = await decryptCookieUploadPayload(0);
      const secondPayload = await decryptCookieUploadPayload(1);
      expect(firstPayload).toEqual([
        expect.objectContaining({ name: 'stale', browserProfile: 'Default' }),
        expect.objectContaining({ name: 'kept', browserProfile: 'Default' }),
      ]);
      expect(secondPayload).toEqual([
        expect.objectContaining({ name: 'kept', browserProfile: 'Default' }),
      ]);
    });

    it('calls AuthService, IntegrationCache, and BrowserCookieReader in the correct order', async () => {
      const callOrder: string[] = [];
      vi.mocked(AuthService.getSession).mockImplementation(async () => {
        callOrder.push('auth');
        return SESSION;
      });
      vi.mocked(IntegrationCache.isConnected).mockImplementation(async () => {
        callOrder.push('integration-cache');
        return true;
      });
      vi.mocked(BrowserCookieReader.readCookies).mockImplementation(async () => {
        callOrder.push('browser-cookie-reader');
        return [makeCookie()];
      });
      installUploadFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));

      await CookieSync.sync();

      expect(callOrder).toEqual(['auth', 'integration-cache', 'browser-cookie-reader']);
      expect(vi.mocked(IntegrationCache.isConnected)).toHaveBeenCalledWith('chrome');
      expect(vi.mocked(BrowserCookieReader.readCookies)).toHaveBeenCalledWith('chrome');
    });
  });

  describe('empty state', () => {
    it('skips upload when AuthService returns no session', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(null);
      installUploadFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));

      await CookieSync.sync();

      expect(fetchCaptures).toHaveLength(0);
      expect(vi.mocked(IntegrationCache.isConnected)).not.toHaveBeenCalled();
      expect(vi.mocked(BrowserCookieReader.readCookies)).not.toHaveBeenCalled();
    });

    it('skips upload when chrome integration is not connected', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      vi.mocked(IntegrationCache.isConnected).mockResolvedValue(false);
      installUploadFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));

      await CookieSync.sync();

      expect(fetchCaptures).toHaveLength(0);
      expect(vi.mocked(BrowserCookieReader.readCookies)).not.toHaveBeenCalled();
    });

    it('skips upload when cookie reader returns an empty list', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      vi.mocked(IntegrationCache.isConnected).mockResolvedValue(true);
      vi.mocked(BrowserCookieReader.readCookies).mockResolvedValue([]);
      installUploadFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));

      await CookieSync.sync();

      expect(fetchCaptures).toHaveLength(0);
    });
  });

  describe('error state', () => {
    it('does not throw when upload returns a non-OK status', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      vi.mocked(IntegrationCache.isConnected).mockResolvedValue(true);
      vi.mocked(BrowserCookieReader.readCookies).mockResolvedValue([makeCookie()]);
      installUploadFetch(
        () =>
          new Response(JSON.stringify({ error: 'boom' }), {
            status: 500,
            statusText: 'Internal Server Error',
          })
      );

      await expect(CookieSync.sync()).resolves.toBeUndefined();

      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].responseStatus).toBe(500);
    });

    it('does not throw when BrowserCookieReader rejects', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      vi.mocked(IntegrationCache.isConnected).mockResolvedValue(true);
      vi.mocked(BrowserCookieReader.readCookies).mockRejectedValue(new Error('keychain denied'));
      installUploadFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));

      await expect(CookieSync.sync()).resolves.toBeUndefined();

      expect(fetchCaptures).toHaveLength(0);
    });
  });

  describe('boundary capture', () => {
    it('sends multipart/form-data with Bearer auth for the encrypted payload', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      vi.mocked(IntegrationCache.isConnected).mockResolvedValue(true);
      vi.mocked(BrowserCookieReader.readCookies).mockResolvedValue([makeCookie()]);
      installUploadFetch(() => new Response(JSON.stringify({ success: true }), { status: 200 }));

      await CookieSync.sync();

      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].headers['content-type']).toMatch(/^multipart\/form-data/);
    });
  });
});
