import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearFetchCaptures,
  fetchCaptures,
  installFetchCapture,
  type MockResponder,
} from './fetch-capture';
import type { AuthSession } from '../../shared/types/ipc';

vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'https://backend.test',
    supabase: { url: 'https://supabase.test', anonKey: 'anon-key-test' },
    encryptionKey: 'encryption-key-test',
    isDev: true,
  },
}));

vi.mock('../../main/base/logger', () => ({
  logConsole: vi.fn(),
  logConsoleError: vi.fn(),
}));

vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: vi.fn<() => Promise<AuthSession | null>>(),
  },
}));

vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: { invalidate: vi.fn(), getIntegration: vi.fn() },
}));

const fsExistsSync = vi.hoisted(() => vi.fn<(path: string) => boolean>(() => false));
const fsReadFileSync = vi.hoisted(() => vi.fn<(path: string, encoding: string) => string>());

vi.mock('fs', () => ({
  default: {
    existsSync: fsExistsSync,
    readFileSync: fsReadFileSync,
  },
  existsSync: fsExistsSync,
  readFileSync: fsReadFileSync,
}));

import { AuthService } from '../../main/services/auth';
import { IntegrationCache } from '../../main/services/sync/IntegrationCache';
import { CODEX_AUTH_PATH } from '../../main/domains/gpt-credential-sync/config';
import { GptCredentialSync } from '../../main/services/gptCredentialSync';

const SESSION: AuthSession = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_at: Date.now() + 60 * 60 * 1000,
  user: { id: 'user-1' },
};

const VALID_CODEX_AUTH = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: {
    access_token: 'codex-access-token-secret',
    refresh_token: 'codex-refresh-token-secret',
    account_id: 'account-1',
  },
});

const happyUpload: MockResponder = () =>
  new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('gpt-credential-sync blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    fsExistsSync.mockReset().mockReturnValue(false);
    fsReadFileSync.mockReset().mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });
    vi.mocked(AuthService.getSession).mockReset();
    vi.mocked(IntegrationCache.invalidate).mockReset();
    vi.mocked(IntegrationCache.getIntegration).mockReset().mockResolvedValue({
      name: 'gpt_code',
      status: 'CONNECTED',
      isActive: true,
    });
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  const installUpload = (responder: MockResponder = happyUpload): void => {
    restoreFetch = installFetchCapture({
      '/api/integrations/gpt-code/credentials/upload': responder,
    });
  };

  const wireCodexAuthFile = (contents = VALID_CODEX_AUTH): void => {
    fsExistsSync.mockReturnValue(true);
    fsReadFileSync.mockReturnValue(contents);
  };

  describe('auth boundary', () => {
    it('returns Not authenticated and skips filesystem/upload/cache work when no session exists', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(null);
      wireCodexAuthFile();
      installUpload();

      const result = await GptCredentialSync.syncCredentials();

      expect(result).toEqual({ success: false, message: 'Not authenticated' });
      expect(fsReadFileSync).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
      expect(vi.mocked(IntegrationCache.invalidate)).not.toHaveBeenCalled();
    });

    it('sends Bearer <session.access_token> on the upload request', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile();
      installUpload();

      const result = await GptCredentialSync.syncCredentials();

      expect(result.success).toBe(true);
      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].headers.authorization).toBe(`Bearer ${SESSION.access_token}`);
    });
  });

  describe('happy path', () => {
    it('reads Codex auth, encrypts, POSTs JSON envelope, and invalidates the integration cache', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile();
      installUpload();

      const result = await GptCredentialSync.syncCredentials();

      expect(result).toEqual({ success: true });
      expect(fsReadFileSync).toHaveBeenCalledWith(CODEX_AUTH_PATH, 'utf8');
      expect(fetchCaptures).toHaveLength(1);

      const req = fetchCaptures[0];
      expect(req.url).toBe('https://backend.test/api/integrations/gpt-code/credentials/upload');
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.responseStatus).toBe(200);

      const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['data', 'iv', 'key']);
      expect(typeof body.data).toBe('string');
      expect(typeof body.iv).toBe('string');
      expect(typeof body.key).toBe('string');
      expect(req.body).not.toContain('codex-access-token-secret');
      expect(req.body).not.toContain('codex-refresh-token-secret');

      expect(vi.mocked(IntegrationCache.invalidate)).toHaveBeenCalledTimes(1);
    });

    it('re-uploads unchanged Codex auth when the backend integration is expired', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      vi.mocked(IntegrationCache.getIntegration)
        .mockResolvedValueOnce({
          name: 'gpt_code',
          status: 'EXPIRED',
          isActive: false,
        })
        .mockResolvedValue({
          name: 'gpt_code',
          status: 'CONNECTED',
          isActive: true,
        });
      wireCodexAuthFile(
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: 'codex-access-token-expired-row',
            refresh_token: 'codex-refresh-token-expired-row',
          },
        })
      );
      installUpload();

      const first = await GptCredentialSync.syncExistingCredentialsIfChanged();
      const second = await GptCredentialSync.syncExistingCredentialsIfChanged();

      expect(first.success).toBe(true);
      expect(second).toEqual({ success: true, message: 'unchanged' });
      expect(fetchCaptures).toHaveLength(1);
      expect(vi.mocked(IntegrationCache.invalidate)).toHaveBeenCalledTimes(1);
    });

    it('skips unchanged Codex auth when the backend integration is still connected', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile(
        JSON.stringify({
          auth_mode: 'chatgpt',
          tokens: {
            access_token: 'codex-access-token-connected-row',
            refresh_token: 'codex-refresh-token-connected-row',
          },
        })
      );
      installUpload();

      const first = await GptCredentialSync.syncExistingCredentialsIfChanged();
      const second = await GptCredentialSync.syncExistingCredentialsIfChanged();

      expect(first.success).toBe(true);
      expect(second).toEqual({ success: true, message: 'unchanged' });
      expect(fetchCaptures).toHaveLength(1);
      expect(vi.mocked(IntegrationCache.invalidate)).toHaveBeenCalledTimes(1);
    });
  });

  describe('empty state', () => {
    it('returns a login instruction and skips upload when ~/.codex/auth.json cannot be read', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      fsReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file');
      });
      installUpload();

      const result = await GptCredentialSync.syncCredentials();

      expect(result).toEqual({
        success: false,
        message: 'Codex credentials not found. Please run codex login in Terminal.',
      });
      expect(fetchCaptures).toHaveLength(0);
      expect(vi.mocked(IntegrationCache.invalidate)).not.toHaveBeenCalled();
    });
  });

  describe('error state', () => {
    it('rejects non-JSON credentials without uploading', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile('not-json-at-all');
      installUpload();

      const result = await GptCredentialSync.syncCredentials();

      expect(result).toEqual({
        success: false,
        message: 'Codex credentials are not valid JSON',
      });
      expect(fetchCaptures).toHaveLength(0);
      expect(vi.mocked(IntegrationCache.invalidate)).not.toHaveBeenCalled();
    });

    it('rejects auth files that are not ChatGPT login mode', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile(
        JSON.stringify({
          auth_mode: 'api-key',
          tokens: {
            access_token: 'codex-access-token-secret',
            refresh_token: 'codex-refresh-token-secret',
          },
        })
      );
      installUpload();

      const result = await GptCredentialSync.syncCredentials();

      expect(result).toEqual({
        success: false,
        message: 'Codex is not logged in with a ChatGPT account',
      });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('rejects ChatGPT auth files missing access or refresh token', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile(JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'one' } }));
      installUpload();

      const result = await GptCredentialSync.syncCredentials();

      expect(result).toEqual({
        success: false,
        message: 'Codex credentials missing access or refresh token. Please run codex login.',
      });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('surfaces backend error message and does not invalidate cache when upload returns non-OK', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile();
      installUpload(
        () =>
          new Response(JSON.stringify({ error: 'server rejected codex auth' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
      );

      const result = await GptCredentialSync.syncCredentials();

      expect(result).toEqual({ success: false, message: 'server rejected codex auth' });
      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].responseStatus).toBe(500);
      expect(vi.mocked(IntegrationCache.invalidate)).not.toHaveBeenCalled();
    });

    it('falls back to a generic upload message when backend returns a non-JSON error body', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile();
      installUpload(
        () => new Response('<html>503 unavailable</html>', { status: 503, statusText: 'Nope' })
      );

      const result = await GptCredentialSync.syncCredentials();

      expect(result.success).toBe(false);
      expect(result.message).toBe('Upload failed: 503');
      expect(vi.mocked(IntegrationCache.invalidate)).not.toHaveBeenCalled();
    });
  });

  describe('boundary capture', () => {
    it('captures POST /api/integrations/gpt-code/credentials/upload with JSON { data, iv, key }', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile();
      installUpload();

      await GptCredentialSync.syncCredentials();

      expect(fetchCaptures).toHaveLength(1);
      const req = fetchCaptures[0];
      expect(req.url).toBe('https://backend.test/api/integrations/gpt-code/credentials/upload');
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.headers.authorization).toBe(`Bearer ${SESSION.access_token}`);

      const body = JSON.parse(req.body ?? '{}') as {
        data: string;
        iv: string;
        key: string;
      };
      expect(body.data).toMatch(/^[0-9a-f]+$/);
      expect(body.iv).toMatch(/^[0-9a-f]{32}$/);
      expect(body.key).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('hasCredentials', () => {
    it('returns true when the Codex auth file exists', () => {
      fsExistsSync.mockReturnValue(true);

      expect(GptCredentialSync.hasCredentials()).toBe(true);
      expect(fsExistsSync).toHaveBeenCalledWith(CODEX_AUTH_PATH);
    });

    it('returns false when the Codex auth file is absent or existsSync throws', () => {
      fsExistsSync.mockReturnValueOnce(false);
      expect(GptCredentialSync.hasCredentials()).toBe(false);

      fsExistsSync.mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });
      expect(GptCredentialSync.hasCredentials()).toBe(false);
    });
  });
});
