import { EventEmitter } from 'events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubAllElectron } from './electron-stubs';
import {
  fetchCaptures,
  clearFetchCaptures,
  installFetchCapture,
  type MockResponder,
} from './fetch-capture';
import type { AuthSession } from '../../shared/types/ipc';

stubAllElectron();

// Pin config to avoid real dotenv lookup.
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

// Collaborators we coordinate with — keep Crypto real so the boundary capture
// observes the actual encrypt → upload shape.
vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: vi.fn<() => Promise<AuthSession | null>>(),
  },
}));

vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: { invalidate: vi.fn() },
}));

// --- child_process stub ---------------------------------------------------
// ClaudeCredentialSync shells out heavily (`security`, `npm`, `claude`). Tests
// must observe what commands it runs (the keychain boundary) AND drive the
// spawn lifecycle for the install/setup-token flow.
interface ExecCall {
  fn: 'execSync' | 'execFileSync';
  command: string;
  args?: readonly string[];
}

interface SpawnedProc {
  args: readonly string[];
  emitter: EventEmitter;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

type ExecHandler = (command: string, args?: readonly string[]) => string | Buffer;

// `vi.mock` factories are hoisted above top-level imports, so any state they
// reference must come from `vi.hoisted` (which runs first).
const cp = vi.hoisted(() => ({
  execCalls: [] as ExecCall[],
  spawnedProcs: [] as SpawnedProc[],
  state: {
    execSyncHandler: (() => '') as ExecHandler,
    execFileSyncHandler: (() => '') as ExecHandler,
  },
}));

const { execCalls, spawnedProcs } = cp;

const setExecSyncHandler = (h: ExecHandler): void => {
  cp.state.execSyncHandler = h;
};
const setExecFileSyncHandler = (h: ExecHandler): void => {
  cp.state.execFileSyncHandler = h;
};

vi.mock('child_process', () => {
  const execSync = (command: string) => {
    cp.execCalls.push({ fn: 'execSync', command });
    return cp.state.execSyncHandler(command);
  };
  const execFileSync = (command: string, args?: readonly string[]) => {
    cp.execCalls.push({ fn: 'execFileSync', command, args });
    return cp.state.execFileSyncHandler(command, args);
  };
  const spawn = (_command: string, args: readonly string[]) => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const emitter = new EventEmitter() as EventEmitter & {
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
  const mod = { execSync, execFileSync, spawn };
  return { ...mod, default: mod };
});

// fs is used to discover npm/claude binaries + NVM versions dirs. Pin it so
// findNpmClaudePath() is deterministic across machines.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(() => true), readdirSync: vi.fn(() => []) },
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => []),
  };
});

import { ClaudeCredentialSync } from '../../main/services/claudeCredentialSync';
import { AuthService } from '../../main/services/auth';
import { IntegrationCache } from '../../main/services/sync/IntegrationCache';

const SESSION: AuthSession = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  expires_at: Date.now() + 60 * 60 * 1000,
  user: { id: 'user-1' },
};

const encodeJwtPart = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const IMPERSONATED_SESSION: AuthSession = {
  ...SESSION,
  access_token: `${encodeJwtPart({ alg: 'HS256' })}.${encodeJwtPart({
    sub: 'target-user',
    act: { sub: 'operator-user' },
  })}.sig`,
  user: { id: 'target-user' },
};

const KEYCHAIN_FIND_CMD = 'security find-generic-password -s "Claude Code-credentials" -w';
const KEYCHAIN_EXISTS_CMD =
  'security find-generic-password -s "Claude Code-credentials" 2>/dev/null';
const VALID_CREDENTIALS = JSON.stringify({
  claudeAiOauth: { accessToken: 'sk-ant-oat-existing-token', expiresAt: Date.now() + 1_000_000 },
});

const happyUpload: MockResponder = () =>
  new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('claude-credential-sync blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    execCalls.length = 0;
    spawnedProcs.length = 0;
    setExecSyncHandler(() => '');
    setExecFileSyncHandler(() => '');
    vi.mocked(AuthService.getSession).mockReset();
    vi.mocked(IntegrationCache.invalidate).mockReset();
    ClaudeCredentialSync.setMockNoClaudeCode(false);
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  const installUpload = (responder: MockResponder = happyUpload): void => {
    restoreFetch = installFetchCapture({
      '/api/integrations/claude-code/credentials/upload': responder,
    });
  };

  /** Default handler: keychain read returns valid credentials JSON. */
  const wireKeychainCredentials = (credentials = VALID_CREDENTIALS): void => {
    setExecSyncHandler((command) => {
      if (command === KEYCHAIN_FIND_CMD) return credentials;
      return '';
    });
  };

  // ------------------------------------------------------------------
  // auth boundary
  // ------------------------------------------------------------------
  describe('auth boundary', () => {
    it('returns { success:false, message:"Not authenticated" } and skips upload when no session', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(null);
      installUpload();

      const result = await ClaudeCredentialSync.syncCredentials();

      expect(result).toEqual({ success: false, message: 'Not authenticated' });
      expect(fetchCaptures).toHaveLength(0);
      expect(vi.mocked(IntegrationCache.invalidate)).not.toHaveBeenCalled();
    });

    it('sends Bearer <session.access_token> on the upload request', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireKeychainCredentials();
      installUpload();

      const result = await ClaudeCredentialSync.syncCredentials();

      expect(result.success).toBe(true);
      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].headers.authorization).toBe(`Bearer ${SESSION.access_token}`);
    });

    it('does not read or upload this Mac credentials while impersonating another user', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(IMPERSONATED_SESSION);
      wireKeychainCredentials();
      installUpload();

      const result = await ClaudeCredentialSync.syncCredentials();

      expect(result).toEqual({
        success: false,
        message: 'Unavailable while viewing another account',
      });
      expect(execCalls).toHaveLength(0);
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // happy path
  // ------------------------------------------------------------------
  describe('happy path', () => {
    it('reads keychain, encrypts, POSTs JSON envelope, and invalidates the integration cache', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireKeychainCredentials();
      installUpload();

      const result = await ClaudeCredentialSync.syncCredentials();

      expect(result).toEqual({ success: true });
      expect(fetchCaptures).toHaveLength(1);
      const req = fetchCaptures[0];
      expect(req.url).toBe('https://backend.test/api/integrations/claude-code/credentials/upload');
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.responseStatus).toBe(200);

      const body = JSON.parse(req.body ?? '{}') as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['data', 'iv', 'key']);
      expect(typeof body.data).toBe('string');
      expect(typeof body.iv).toBe('string');
      expect(typeof body.key).toBe('string');
      // Encrypted payload must not leak the plaintext credentials.
      expect(req.body).not.toContain('sk-ant-oat-existing-token');

      expect(vi.mocked(IntegrationCache.invalidate)).toHaveBeenCalledTimes(1);

      // Keychain read must have happened (observable side effect on the host).
      expect(execCalls.some((c) => c.command === KEYCHAIN_FIND_CMD)).toBe(true);
    });

    it('pushes claude:setupStatus progress events to the BrowserWindow', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireKeychainCredentials();
      installUpload();

      const send = vi.fn();
      const window = { webContents: { send } };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await ClaudeCredentialSync.syncCredentials(window as any);

      const events = send.mock.calls
        .filter(([channel]) => channel === 'claude:setupStatus')
        .map(([, status]) => status);
      // Happy path has credentials already, so we skip install/OAuth and go
      // straight through Uploading + clear.
      expect(events).toContain('Uploading credentials...');
      expect(events[events.length - 1]).toBe('');
    });
  });

  // ------------------------------------------------------------------
  // empty state — no credentials in keychain, no claude CLI installed
  // ------------------------------------------------------------------
  describe('empty state (no keychain credentials)', () => {
    it('installs claude CLI, runs setup-token, re-reads keychain, and uploads', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      installUpload();

      // First keychain read: empty. After setup-token "writes" credentials,
      // switch the handler to return them.
      let keychainHasCredentials = false;
      setExecSyncHandler((command) => {
        if (command === 'npm config get prefix') return '/fake/npm';
        if (command === 'which npm') return '/fake/npm/bin/npm';
        if (command === KEYCHAIN_FIND_CMD) {
          if (!keychainHasCredentials) throw new Error('item not found');
          return VALID_CREDENTIALS;
        }
        return '';
      });
      setExecFileSyncHandler((command, args) => {
        if (command === 'security' && args?.[0] === 'add-generic-password') {
          keychainHasCredentials = true;
        }
        return '';
      });

      const syncPromise = ClaudeCredentialSync.syncCredentials();

      // Drive the setup-token spawn: emit the token and close cleanly.
      await vi.waitFor(() => {
        expect(spawnedProcs.find((p) => p.args.includes('setup-token'))).toBeDefined();
      });
      const setupTokenProc = spawnedProcs.find((p) => p.args.includes('setup-token'))!;
      setupTokenProc.stdout.emit('data', Buffer.from('Your token: sk-ant-oat-abc123_def456-XYZ\n'));
      setupTokenProc.emitter.emit('close', 0);

      const result = await syncPromise;

      expect(result).toEqual({ success: true });
      expect(fetchCaptures).toHaveLength(1);
      // Keychain write happened with add-generic-password for the right service.
      const keychainWrite = execCalls.find(
        (c) => c.fn === 'execFileSync' && c.args?.[0] === 'add-generic-password'
      );
      expect(keychainWrite).toBeDefined();
      expect(keychainWrite?.args).toContain('-s');
      expect(keychainWrite?.args).toContain('Claude Code-credentials');
    });

    it('returns failure when claude setup-token exits non-zero', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      installUpload();

      setExecSyncHandler((command) => {
        if (command === 'npm config get prefix') return '/fake/npm';
        if (command === KEYCHAIN_FIND_CMD) throw new Error('item not found');
        return '';
      });

      const syncPromise = ClaudeCredentialSync.syncCredentials();

      await vi.waitFor(() => {
        expect(spawnedProcs.find((p) => p.args.includes('setup-token'))).toBeDefined();
      });
      const proc = spawnedProcs.find((p) => p.args.includes('setup-token'))!;
      proc.stderr.emit('data', Buffer.from('auth failed'));
      proc.emitter.emit('close', 1);

      const result = await syncPromise;
      expect(result.success).toBe(false);
      expect(result.message).toMatch(/claude setup-token failed/);
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------
  // error state — malformed credentials, upload failures
  // ------------------------------------------------------------------
  describe('error state', () => {
    it('rejects non-JSON credentials without uploading', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireKeychainCredentials('not-json-at-all');
      installUpload();

      const result = await ClaudeCredentialSync.syncCredentials();

      expect(result).toEqual({
        success: false,
        message: 'Claude Code credentials are not valid JSON',
      });
      expect(fetchCaptures).toHaveLength(0);
      expect(vi.mocked(IntegrationCache.invalidate)).not.toHaveBeenCalled();
    });

    it('rejects JSON without claudeAiOauth.accessToken', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireKeychainCredentials(JSON.stringify({ claudeAiOauth: {} }));
      installUpload();

      const result = await ClaudeCredentialSync.syncCredentials();

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/missing OAuth access token/);
      expect(fetchCaptures).toHaveLength(0);
    });

    it('surfaces backend error message when upload returns non-OK', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireKeychainCredentials();
      installUpload(
        () =>
          new Response(JSON.stringify({ error: 'server exploded' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
      );

      const result = await ClaudeCredentialSync.syncCredentials();

      expect(result).toEqual({ success: false, message: 'server exploded' });
      expect(fetchCaptures).toHaveLength(1);
      expect(fetchCaptures[0].responseStatus).toBe(500);
      // Cache must NOT be invalidated on upload failure.
      expect(vi.mocked(IntegrationCache.invalidate)).not.toHaveBeenCalled();
    });

    it('falls back to generic message when backend returns non-JSON error body', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireKeychainCredentials();
      installUpload(
        () => new Response('<html>500 boom</html>', { status: 503, statusText: 'Unavailable' })
      );

      const result = await ClaudeCredentialSync.syncCredentials();

      expect(result.success).toBe(false);
      expect(result.message).toMatch(/Upload failed: 503/);
    });
  });

  // ------------------------------------------------------------------
  // boundary capture — exact params the backend upload endpoint sees
  // ------------------------------------------------------------------
  describe('boundary capture', () => {
    it('captures POST /api/integrations/claude-code/credentials/upload with JSON { data, iv, key }', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
      wireKeychainCredentials();
      installUpload();

      await ClaudeCredentialSync.syncCredentials();

      expect(fetchCaptures).toHaveLength(1);
      const req = fetchCaptures[0];
      expect(req.url).toBe('https://backend.test/api/integrations/claude-code/credentials/upload');
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toBe('application/json');
      expect(req.headers.authorization).toBe(`Bearer ${SESSION.access_token}`);

      const body = JSON.parse(req.body ?? '{}') as {
        data: string;
        iv: string;
        key: string;
      };
      // data is hex-encoded ciphertext; iv is hex (32 chars = 16 bytes); key is hex (64 chars = 32 bytes).
      expect(body.data).toMatch(/^[0-9a-f]+$/);
      expect(body.iv).toMatch(/^[0-9a-f]{32}$/);
      expect(body.key).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ------------------------------------------------------------------
  // hasCredentials — thin public helper
  // ------------------------------------------------------------------
  describe('hasCredentials', () => {
    it('returns true when the keychain lookup succeeds', () => {
      setExecSyncHandler((command) => {
        if (command === KEYCHAIN_EXISTS_CMD) return '';
        throw new Error('not-found');
      });
      expect(ClaudeCredentialSync.hasCredentials()).toBe(true);
    });

    it('returns false when the keychain lookup throws', () => {
      setExecSyncHandler(() => {
        throw new Error('item not found');
      });
      expect(ClaudeCredentialSync.hasCredentials()).toBe(false);
    });
  });
});
