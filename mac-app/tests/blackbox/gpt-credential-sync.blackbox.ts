import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearFetchCaptures,
  fetchCaptures,
  installFetchCapture,
  type MockResponder,
} from './fetch-capture';
import type { BrowserWindow } from 'electron';
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
const fsReaddirSync = vi.hoisted(() => vi.fn<(path: string) => string[]>(() => []));
const fsWriteFileSync = vi.hoisted(() =>
  vi.fn<(path: string, data: string, opts?: unknown) => void>()
);

vi.mock('fs', () => {
  const mod = {
    existsSync: fsExistsSync,
    readFileSync: fsReadFileSync,
    readdirSync: fsReaddirSync,
    writeFileSync: fsWriteFileSync,
  };
  return { ...mod, default: mod };
});

// --- child_process stub ---------------------------------------------------
// The connect flow shells out to `npm` and `codex`. Tests must observe which
// commands run AND drive the spawn lifecycle for install / login.
interface ExecCall {
  fn: 'execSync';
  command: string;
}

interface SpawnedProc {
  args: readonly string[];
  emitter: EventEmitter;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

type ExecHandler = (command: string) => string | Buffer;

const cp = vi.hoisted(() => ({
  execCalls: [] as ExecCall[],
  spawnedProcs: [] as SpawnedProc[],
  state: { execSyncHandler: (() => '') as ExecHandler },
}));

const { execCalls, spawnedProcs } = cp;

const setExecSyncHandler = (handler: ExecHandler): void => {
  cp.state.execSyncHandler = handler;
};

vi.mock('child_process', async () => {
  const { EventEmitter: Emitter } = await vi.importActual<typeof import('events')>('events');
  const execSync = (command: string) => {
    cp.execCalls.push({ fn: 'execSync', command });
    return cp.state.execSyncHandler(command);
  };
  const spawn = (_command: string, args: readonly string[]) => {
    const stdout = new Emitter();
    const stderr = new Emitter();
    const emitter = new Emitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    emitter.stdout = stdout;
    emitter.stderr = stderr;
    emitter.kill = () => {};
    cp.spawnedProcs.push({ args, emitter, stdout, stderr });
    return emitter;
  };
  const mod = { execSync, spawn, execFileSync: () => '' };
  return { ...mod, default: mod };
});

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

  /** Contents the fake ~/.codex/auth.json currently holds (null = absent). */
  let authFileContents: string | null = null;
  /** Whether `codex --version` succeeds. */
  let codexUsable = true;

  beforeEach(() => {
    clearFetchCaptures();
    authFileContents = null;
    codexUsable = true;
    execCalls.length = 0;
    spawnedProcs.length = 0;

    fsExistsSync
      .mockReset()
      .mockImplementation((p) => p === CODEX_AUTH_PATH && authFileContents !== null);
    fsReadFileSync.mockReset().mockImplementation((p) => {
      if (p === CODEX_AUTH_PATH && authFileContents !== null) return authFileContents;
      throw new Error('ENOENT: no such file');
    });
    fsReaddirSync.mockReset().mockReturnValue([]);
    fsWriteFileSync.mockReset();

    setExecSyncHandler((command) => {
      if (command.includes('--version')) {
        if (!codexUsable) throw new Error('spawn codex ENOENT');
        return 'codex-cli 0.0.0';
      }
      if (command === 'npm config get prefix') return '/fake/npm';
      if (command === 'which npm') return '/fake/npm/bin/npm';
      return '';
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
    authFileContents = contents;
  };

  const findProc = (arg: string): SpawnedProc | undefined =>
    spawnedProcs.find((p) => p.args.includes(arg));

  /**
   * Wait for `codex login` to be spawned, then complete it. When `writes` is
   * given, the login "writes" that content to auth.json before exiting 0.
   */
  const completeCodexLogin = async (writes: string | null = VALID_CODEX_AUTH): Promise<void> => {
    await vi.waitFor(() => {
      expect(findProc('login')).toBeDefined();
    });
    const proc = findProc('login')!;
    if (writes !== null) authFileContents = writes;
    proc.emitter.emit('close', 0);
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

  // ------------------------------------------------------------------
  // connect flow — the app must be able to *obtain* a ChatGPT login, not
  // just report on one the user is expected to create in Terminal.
  // ------------------------------------------------------------------
  describe('connect flow (no ChatGPT credentials yet)', () => {
    it('runs codex login, re-reads auth.json, and uploads when no auth file exists', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      installUpload();

      const syncPromise = GptCredentialSync.syncCredentials();
      await completeCodexLogin();
      const result = await syncPromise;

      expect(result).toEqual({ success: true });
      expect(findProc('login')).toBeDefined();
      expect(fetchCaptures).toHaveLength(1);
      expect(vi.mocked(IntegrationCache.invalidate)).toHaveBeenCalledTimes(1);
    });

    it('runs codex login instead of dead-ending when Codex is in API-key mode', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile(
        JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-proj-existing-key' })
      );
      installUpload();

      const syncPromise = GptCredentialSync.syncCredentials();
      await completeCodexLogin();
      const result = await syncPromise;

      expect(result).toEqual({ success: true });
      expect(fetchCaptures).toHaveLength(1);
    });

    it('backs up an existing API-key auth.json before codex login overwrites it', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      const existing = JSON.stringify({
        auth_mode: 'apikey',
        OPENAI_API_KEY: 'sk-proj-existing-key',
      });
      wireCodexAuthFile(existing);
      installUpload();

      const syncPromise = GptCredentialSync.syncCredentials();
      await completeCodexLogin();
      await syncPromise;

      expect(fsWriteFileSync).toHaveBeenCalledWith(
        `${CODEX_AUTH_PATH}.apikey.bak`,
        existing,
        expect.objectContaining({ mode: 0o600 })
      );
    });

    it('installs the Codex CLI first when `codex --version` fails (missing or broken binary)', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      codexUsable = false;
      installUpload();

      const syncPromise = GptCredentialSync.syncCredentials();

      await vi.waitFor(() => {
        expect(findProc('@openai/codex')).toBeDefined();
      });
      const installProc = findProc('@openai/codex')!;
      expect(installProc.args).toEqual(['install', '-g', '--force', '@openai/codex']);
      codexUsable = true;
      installProc.emitter.emit('close', 0);

      await completeCodexLogin();
      const result = await syncPromise;

      expect(result).toEqual({ success: true });
      expect(fetchCaptures).toHaveLength(1);
    });

    it('reports a manual install command when the CLI is still unusable after install', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      codexUsable = false;
      installUpload();

      const syncPromise = GptCredentialSync.syncCredentials();

      await vi.waitFor(() => {
        expect(findProc('@openai/codex')).toBeDefined();
      });
      findProc('@openai/codex')!.emitter.emit('close', 0);

      const result = await syncPromise;

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        'Codex installation failed. Please install manually: npm install -g @openai/codex'
      );
      expect(fetchCaptures).toHaveLength(0);
    });

    it('surfaces a login failure without uploading when codex login exits non-zero', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      installUpload();

      const syncPromise = GptCredentialSync.syncCredentials();

      await vi.waitFor(() => {
        expect(findProc('login')).toBeDefined();
      });
      const proc = findProc('login')!;
      proc.stderr.emit('data', Buffer.from('user cancelled'));
      proc.emitter.emit('close', 1);

      const result = await syncPromise;

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/codex login failed/);
      expect(fetchCaptures).toHaveLength(0);
      expect(vi.mocked(IntegrationCache.invalidate)).not.toHaveBeenCalled();
    });

    it('reports a clear failure when login succeeds but writes no credentials', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      installUpload();

      const syncPromise = GptCredentialSync.syncCredentials();
      await completeCodexLogin(null);
      const result = await syncPromise;

      expect(result).toEqual({
        success: false,
        message:
          'ChatGPT sign-in completed but no Codex credentials were written. Please try again.',
      });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('streams gpt:setupStatus progress to the BrowserWindow during login', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      installUpload();

      const send = vi.fn();
      const window = { webContents: { send } } as unknown as BrowserWindow;
      const syncPromise = GptCredentialSync.syncCredentials(window);
      await completeCodexLogin();
      await syncPromise;

      const events = send.mock.calls
        .filter(([channel]) => channel === 'gpt:setupStatus')
        .map(([, status]) => status);
      expect(events).toContain('Opening browser to sign in to ChatGPT...');
      expect(events).toContain('Uploading credentials...');
      expect(events[events.length - 1]).toBe('');
    });

    it('never launches a login from the non-interactive periodic refresh', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireCodexAuthFile(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-proj-key' }));
      installUpload();

      const result = await GptCredentialSync.syncExistingCredentialsIfChanged();

      expect(result).toEqual({
        success: false,
        message: 'Codex is not logged in with a ChatGPT account',
      });
      expect(spawnedProcs).toHaveLength(0);
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  describe('error state', () => {
    it('rejects non-JSON credentials without uploading', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      installUpload();

      const syncPromise = GptCredentialSync.syncCredentials();
      await completeCodexLogin('not-json-at-all');
      const result = await syncPromise;

      expect(result).toEqual({
        success: false,
        message: 'Codex credentials are not valid JSON',
      });
      expect(fetchCaptures).toHaveLength(0);
      expect(vi.mocked(IntegrationCache.invalidate)).not.toHaveBeenCalled();
    });

    it('rejects auth files that are not ChatGPT login mode', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      installUpload();

      const syncPromise = GptCredentialSync.syncCredentials();
      await completeCodexLogin(
        JSON.stringify({
          auth_mode: 'api-key',
          tokens: {
            access_token: 'codex-access-token-secret',
            refresh_token: 'codex-refresh-token-secret',
          },
        })
      );
      const result = await syncPromise;

      expect(result).toEqual({
        success: false,
        message: 'Codex is not logged in with a ChatGPT account',
      });
      expect(fetchCaptures).toHaveLength(0);
    });

    it('rejects ChatGPT auth files missing access or refresh token', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      installUpload();

      const syncPromise = GptCredentialSync.syncCredentials();
      await completeCodexLogin(
        JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'one' } })
      );
      const result = await syncPromise;

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
      wireCodexAuthFile();

      expect(GptCredentialSync.hasCredentials()).toBe(true);
      expect(fsExistsSync).toHaveBeenCalledWith(CODEX_AUTH_PATH);
    });

    it('returns false when the Codex auth file is absent or existsSync throws', () => {
      expect(GptCredentialSync.hasCredentials()).toBe(false);

      fsExistsSync.mockImplementationOnce(() => {
        throw new Error('EACCES: permission denied');
      });
      expect(GptCredentialSync.hasCredentials()).toBe(false);
    });
  });
});
