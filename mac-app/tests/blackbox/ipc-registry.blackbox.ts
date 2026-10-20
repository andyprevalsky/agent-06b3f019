/**
 * Blackbox tests for the IPC registry (main/handlers/registry.ts).
 *
 * The registry is the single coordination point that wires every `ipcMain.handle`
 * channel for the Electron main process. This suite verifies the registry's
 * OBSERVABLE contract:
 *
 *   - which channels are registered
 *   - that each channel's handler returns the documented response shape for
 *     happy-path / unauthenticated / error inputs
 *   - that handlers which hit the backend (telegram:* integration-connect flows)
 *     send the exact URL + method + auth header + content-type we expect, as
 *     captured by fetch-capture
 *
 * Internals under test (services, electron-store data, loggers) are mocked so
 * the tests assert only on the channel contract — the same surface renderers
 * see via `window.api.*`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFetchCaptures, fetchCaptures, installFetchCapture } from './fetch-capture';

// ---------------------------------------------------------------------------
// 1. Capture ipcMain.handle registrations into a shared map.
// ---------------------------------------------------------------------------
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

const globalShortcutRegister = vi.fn(() => true);
const globalShortcutUnregister = vi.fn();
const shellOpenExternal = vi.fn(async () => undefined);
const shellOpenPath = vi.fn(async () => '');
const browserWindowFromWebContents = vi.fn(() => null);

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
    removeHandler: vi.fn(),
  },
  BrowserWindow: Object.assign(vi.fn(), {
    fromWebContents: browserWindowFromWebContents,
  }),
  shell: {
    openExternal: shellOpenExternal,
    openPath: shellOpenPath,
  },
  globalShortcut: {
    register: globalShortcutRegister,
    unregister: globalShortcutUnregister,
  },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/mac-app-test'),
    getName: vi.fn(() => 'rose-desktop-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
  },
}));

// ---------------------------------------------------------------------------
// 2. Stub heavy / environment-dependent base modules so registry.ts can import
//    cleanly inside jsdom + node test env without real env vars or filesystem.
//    Electron-store is inlined here (not via stubElectronStore) because the
//    shared helper's hoisting conflicts with the custom electron mock above
//    when both come from different `vi.mock` call sites in this file.
// ---------------------------------------------------------------------------
vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => {
    const storage = new Map<string, unknown>();
    return {
      get: vi.fn((key: string, fallback?: unknown) =>
        storage.has(key) ? storage.get(key) : fallback
      ),
      set: vi.fn((key: string, value: unknown) => storage.set(key, value)),
      delete: vi.fn((key: string) => storage.delete(key)),
      clear: vi.fn(() => storage.clear()),
      has: vi.fn((key: string) => storage.has(key)),
    };
  }),
}));

vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'https://backend.test',
    supabase: { url: 'https://supabase.test', anonKey: 'anon-key' },
    encryptionKey: 'test-key',
    isDev: true,
  },
}));

vi.mock('../../main/base/logger', () => ({
  logIpc: vi.fn(),
  logConsole: vi.fn(),
  logConsoleError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// 3. Mock every service the registry pulls in. Tests tweak return values via
//    the exported mock handles below.
// ---------------------------------------------------------------------------
const authGetSession = vi.fn();
const authSetSession = vi.fn();
const authClearSession = vi.fn();
vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: (...a: unknown[]) => authGetSession(...a),
    setSession: (...a: unknown[]) => authSetSession(...a),
    clearSession: (...a: unknown[]) => authClearSession(...a),
  },
}));

const imsgCheckAccess = vi.fn(() => true);
const imsgReadMessages = vi.fn(async () => []);
vi.mock('../../main/services/iMessageReader', () => ({
  IMessageReader: {
    checkAccess: (...a: unknown[]) => imsgCheckAccess(...a),
    readMessages: (...a: unknown[]) => imsgReadMessages(...a),
  },
}));

const imsgSenderSend = vi.fn(async () => undefined);
vi.mock('../../main/services/iMessageSender', () => ({
  IMessageSender: {
    send: (...a: unknown[]) => imsgSenderSend(...a),
  },
}));

const imsgSyncRun = vi.fn(async () => undefined);
vi.mock('../../main/services/iMessageSync', () => ({
  IMessageSync: {
    sync: (...a: unknown[]) => imsgSyncRun(...a),
  },
}));

const cookieReaderRead = vi.fn(async () => []);
vi.mock('../../main/services/cookieReader', () => ({
  CookieReader: {
    readCookies: (...a: unknown[]) => cookieReaderRead(...a),
  },
}));

const browserReaderInstalled = vi.fn(() => []);
const browserReaderReadCookies = vi.fn(async () => []);
vi.mock('../../main/services/browserCookieReader', () => ({
  BrowserCookieReader: {
    getInstalledBrowsers: (...a: unknown[]) => browserReaderInstalled(...a),
    readCookies: (...a: unknown[]) => browserReaderReadCookies(...a),
  },
}));

const browserStateSync = vi.fn(async () => ({ success: true }));
const browserStateSyncPwd = vi.fn(async () => ({ success: true }));
const browserStateSyncStart = vi.fn(async () => undefined);
vi.mock('../../main/services/browserStateSync', () => ({
  BrowserStateSync: {
    syncBrowser: (...a: unknown[]) => browserStateSync(...a),
    syncBrowserPasswordsOnly: (...a: unknown[]) => browserStateSyncPwd(...a),
    sync: (...a: unknown[]) => browserStateSyncStart(...a),
  },
}));

const fpCollect = vi.fn(async () => ({ ok: 'fp' }));
vi.mock('../../main/services/fingerprintReader', () => ({
  FingerprintReader: {
    collectFingerprint: (...a: unknown[]) => fpCollect(...a),
  },
}));

const batchUpload = vi.fn(async () => ({ success: true }));
vi.mock('../../main/services/batchUploader', () => ({
  BatchUploader: {
    uploadInBatches: (...a: unknown[]) => batchUpload(...a),
  },
}));

const atlasStore = vi.fn(() => ({ success: true }));
const atlasHas = vi.fn(() => false);
const atlasClear = vi.fn(() => ({ success: true }));
vi.mock('../../main/services/atlasCredentialStore', () => ({
  AtlasCredentialStore: {
    storePassword: (...a: unknown[]) => atlasStore(...a),
    hasPassword: (...a: unknown[]) => atlasHas(...a),
    clearPassword: (...a: unknown[]) => atlasClear(...a),
  },
}));

const claudeHas = vi.fn(() => false);
const claudeSync = vi.fn(async () => ({ success: true }));
const claudeSetMock = vi.fn();
vi.mock('../../main/services/claudeCredentialSync', () => ({
  ClaudeCredentialSync: {
    hasCredentials: (...a: unknown[]) => claudeHas(...a),
    syncCredentials: (...a: unknown[]) => claudeSync(...a),
    setMockNoClaudeCode: (...a: unknown[]) => claudeSetMock(...a),
  },
}));

const waHas = vi.fn(() => false);
const waPhone = vi.fn(() => null);
const waConnected = vi.fn(() => false);
const waConnect = vi.fn(async () => undefined);
const waDisconnect = vi.fn(async () => undefined);
const waLogout = vi.fn(async () => undefined);
const waList = vi.fn(() => [] as Array<{ accountId: string; connected: boolean }>);
const waAdd = vi.fn(async () => undefined);
vi.mock('../../main/services/messaging/platforms/whatsapp/WhatsAppSync', () => ({
  WhatsAppSync: {
    hasCredentials: (...a: unknown[]) => waHas(...a),
    getLinkedPhoneNumber: (...a: unknown[]) => waPhone(...a),
    isConnected: (...a: unknown[]) => waConnected(...a),
    listAccounts: (...a: unknown[]) => waList(...a),
    connect: (...a: unknown[]) => waConnect(...a),
    addAccount: (...a: unknown[]) => waAdd(...a),
    disconnect: (...a: unknown[]) => waDisconnect(...a),
    logout: (...a: unknown[]) => waLogout(...a),
  },
}));

const tgHasSession = vi.fn(() => false);
const tgHasApi = vi.fn(() => false);
const tgConnected = vi.fn(() => false);
const tgConnectExisting = vi.fn(async () => true);
const tgDisconnect = vi.fn(async () => undefined);
const tgLogout = vi.fn(async () => undefined);
const tgSyncHistorical = vi.fn(async () => 0);
const tgStartAuth = vi.fn(async () => ({ success: true }));
const tgSubmitCode = vi.fn();
const tgSubmitPassword = vi.fn();
const tgCancelAuth = vi.fn();
const tgGetClient = vi.fn(() => null);
vi.mock('../../main/services/messaging/platforms/telegram/TelegramSync', () => ({
  TelegramSync: {
    hasSession: (...a: unknown[]) => tgHasSession(...a),
    hasApiCredentials: (...a: unknown[]) => tgHasApi(...a),
    isConnected: (...a: unknown[]) => tgConnected(...a),
    connectWithExistingSession: (...a: unknown[]) => tgConnectExisting(...a),
    disconnect: (...a: unknown[]) => tgDisconnect(...a),
    logout: (...a: unknown[]) => tgLogout(...a),
    syncHistorical: (...a: unknown[]) => tgSyncHistorical(...a),
    startAuth: (...a: unknown[]) => tgStartAuth(...a),
    submitCode: (...a: unknown[]) => tgSubmitCode(...a),
    submitPassword: (...a: unknown[]) => tgSubmitPassword(...a),
    cancelAuth: (...a: unknown[]) => tgCancelAuth(...a),
    getClient: (...a: unknown[]) => tgGetClient(...a),
  },
}));

const syncManagerStart = vi.fn(async () => undefined);
const syncManagerStop = vi.fn(async () => undefined);
vi.mock('../../main/services/sync/SyncManager', () => ({
  SyncManager: {
    startAll: (...a: unknown[]) => syncManagerStart(...a),
    stopAll: (...a: unknown[]) => syncManagerStop(...a),
  },
}));

const requestPasskeyAutoFillPermission = vi.fn(async () => ({
  success: true,
  enabled: true,
  openedSettings: false,
}));
const getPasskeyAutoFillStatus = vi.fn(async () => ({
  success: true,
  enabled: true,
  credentialExchangeEnabled: true,
}));
vi.mock('../../main/domains/passkey-permission/service', () => ({
  requestPasskeyAutoFillPermission: (...a: unknown[]) => requestPasskeyAutoFillPermission(...a),
  getPasskeyAutoFillStatus: (...a: unknown[]) => getPasskeyAutoFillStatus(...a),
}));

const prepareCredentialExchangeHandoff = vi.fn(async () => ({
  activityPath: '/tmp/credential-exchange-activity.json',
  appPath: '/Applications/Rose.app',
  pluginPath: '/Applications/Rose.app/Contents/PlugIns/PasskeyProvider.appex',
  restartedProcesses: [],
  staleLaunchServicesRecords: [],
  credentialExchangeLaunchServicesRecords: [],
}));
vi.mock('../../main/domains/passkey-import/handoff-state', () => ({
  prepareCredentialExchangeHandoff: (...a: unknown[]) => prepareCredentialExchangeHandoff(...a),
}));

const integrationCacheInvalidate = vi.fn();
vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: { invalidate: (...a: unknown[]) => integrationCacheInvalidate(...a) },
}));

// execAsync is only hit by system:openKeychainAccess when searchQuery is non-empty.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    exec: vi.fn((_cmd: string, cb?: (err: Error | null, out: string) => void) => {
      cb?.(null, '');
    }),
  };
});

// ---------------------------------------------------------------------------
// 4. Import registry AFTER all mocks are in place. This triggers
//    registerHandlers() and populates the `handlers` map.
// ---------------------------------------------------------------------------
await import('../../main/handlers/registry');

// Helpers ------------------------------------------------------------------
function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel: ${channel}`);
  const fakeEvent = { sender: {} };
  return Promise.resolve(handler(fakeEvent, ...args) as T);
}

const fakeSession = {
  access_token: 'tok-abc',
  refresh_token: 'refresh',
  user: { id: 'u1' },
  expires_at: Date.now() + 60_000,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ipc-registry: channel registration', () => {
  it('registers every documented channel from the IPC contract', () => {
    const expected = [
      'auth:check',
      'auth:save',
      'auth:clear',
      'imessage:checkAccess',
      'imessage:startUpload',
      'imessage:sendDirect',
      'cookies:readChrome',
      'cookies:upload',
      'cookies:getInstalledBrowsers',
      'cookies:readBrowser',
      'cookies:uploadBrowser',
      'browser:sync',
      'browser:syncPasswords',
      'fingerprint:collect',
      'fingerprint:upload',
      'system:openFullDiskAccess',
      'system:openKeychainAccess',
      'system:openPasswordsApp',
      'shell:openExternal',
      'shortcut:get',
      'shortcut:set',
      'shortcut:validate',
      'onboarding:isComplete',
      'onboarding:setComplete',
      'onboarding:getLastAuthProvider',
      'onboarding:setLastAuthProvider',
      'atlas:storePassword',
      'atlas:hasPassword',
      'atlas:clearPassword',
      'claude:hasCredentials',
      'claude:syncCredentials',
      'claude:setMockNoClaudeCode',
      'whatsapp:hasCredentials',
      'whatsapp:getLinkedPhoneNumber',
      'whatsapp:isConnected',
      'whatsapp:listAccounts',
      'whatsapp:connect',
      'whatsapp:addAccount',
      'whatsapp:disconnect',
      'whatsapp:logout',
      'telegram:hasSession',
      'telegram:hasApiCredentials',
      'telegram:isConnected',
      'telegram:connectWithExistingSession',
      'telegram:disconnect',
      'telegram:logout',
      'telegram:syncHistorical',
      'telegram:startAuth',
      'telegram:submitCode',
      'telegram:submitPassword',
      'telegram:cancelAuth',
    ];
    for (const channel of expected) {
      expect(handlers.has(channel), `missing handler: ${channel}`).toBe(true);
    }
  });

  it('kicks off SyncManager at module load', () => {
    expect(syncManagerStart).toHaveBeenCalled();
  });
});

describe('ipc-registry: auth channels', () => {
  beforeEach(() => {
    authGetSession.mockReset();
    authSetSession.mockReset();
    authClearSession.mockReset();
  });

  it('auth:check returns the current session', async () => {
    authGetSession.mockResolvedValueOnce(fakeSession);
    const result = await invoke('auth:check');
    expect(result).toEqual(fakeSession);
  });

  it('auth:check returns null when no session', async () => {
    authGetSession.mockResolvedValueOnce(null);
    const result = await invoke('auth:check');
    expect(result).toBeNull();
  });

  it('auth:save persists the session and returns success', async () => {
    const result = await invoke('auth:save', fakeSession);
    expect(authSetSession).toHaveBeenCalledWith(fakeSession);
    expect(result).toEqual({ success: true });
  });

  /**
   * auth:save is the switch path: the renderer syncs the newly minted session to
   * the bridge, and the handler immediately uploads THIS machine's iMessage
   * history, cookies, and browser state. While impersonating, that session is the
   * TARGET user, so those uploads would write the operator's personal data into
   * someone else's account — unrecoverable cross-account corruption.
   */
  it('auth:save skips post-auth syncs and stops watchers for an impersonated session', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const impersonatedToken =
      `${b64({ alg: 'HS256', typ: 'JWT' })}.` +
      `${b64({ sub: 'target-user', act: { sub: 'admin-user' } })}.sig`;

    imsgSyncRun.mockClear();
    syncManagerStop.mockClear();

    const result = await invoke('auth:save', { ...fakeSession, access_token: impersonatedToken });

    expect(result).toEqual({ success: true });
    expect(imsgSyncRun).not.toHaveBeenCalled();
    expect(syncManagerStop).toHaveBeenCalled();
  });

  it('auth:save stops the old identity before persisting an impersonated session', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const impersonatedToken =
      `${b64({ alg: 'HS256', typ: 'JWT' })}.` +
      `${b64({ sub: 'target-user', act: { sub: 'admin-user' } })}.sig`;
    let finishStop: (() => void) | undefined;
    syncManagerStop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        })
    );

    const saving = invoke('auth:save', { ...fakeSession, access_token: impersonatedToken });
    await Promise.resolve();

    expect(authSetSession).not.toHaveBeenCalled();
    finishStop?.();
    await saving;
    expect(authSetSession).toHaveBeenCalled();
  });

  it('auth:save restarts managed syncs without direct upload fan-out on the operator session', async () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const ownToken = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'admin-user' })}.sig`;

    imsgSyncRun.mockClear();
    syncManagerStart.mockClear();

    await invoke('auth:save', { ...fakeSession, access_token: ownToken });

    expect(imsgSyncRun).not.toHaveBeenCalled();
    expect(syncManagerStart).toHaveBeenCalledTimes(1);
  });

  it('auth:clear stops watchers so nothing syncs after sign-out', async () => {
    syncManagerStop.mockClear();
    await invoke('auth:clear');
    expect(syncManagerStop).toHaveBeenCalled();
  });

  it('auth:clear wipes the session', async () => {
    const result = await invoke('auth:clear');
    expect(authClearSession).toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });
});

describe('ipc-registry: local machine uploads while impersonating', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const impersonatedSession = {
    ...fakeSession,
    access_token: `${encode({ alg: 'HS256' })}.${encode({
      sub: 'target-user',
      act: { sub: 'admin-user' },
    })}.signature`,
  };

  beforeEach(() => {
    authGetSession.mockReset();
    authGetSession.mockResolvedValue(impersonatedSession);
    batchUpload.mockClear();
    imsgCheckAccess.mockReturnValue(true);
    imsgReadMessages.mockResolvedValue([]);
  });

  it.each([
    ['imessage:startUpload', []],
    ['cookies:upload', [[]]],
    ['cookies:uploadBrowser', ['chrome', []]],
    ['fingerprint:upload', [{}]],
    ['passkeys:enroll', [{ url: 'https://example.test/security' }]],
    ['passkeys:importFromToken', ['credential-exchange-token']],
  ] as const)(
    '%s refuses to upload this Mac data into the target account',
    async (channel, args) => {
      const result = await invoke<{ success: boolean; message?: string }>(channel, ...args);

      expect(result).toEqual({
        success: false,
        message: 'Unavailable while viewing another account',
      });
      expect(batchUpload).not.toHaveBeenCalled();
    }
  );
});

describe('ipc-registry: iMessage channels', () => {
  beforeEach(() => {
    imsgCheckAccess.mockReset();
    imsgReadMessages.mockReset();
    imsgSenderSend.mockReset();
    authGetSession.mockReset();
    batchUpload.mockReset();
  });

  it('imessage:checkAccess returns the reader boolean', async () => {
    imsgCheckAccess.mockReturnValueOnce(true);
    await expect(invoke('imessage:checkAccess')).resolves.toBe(true);
    imsgCheckAccess.mockReturnValueOnce(false);
    await expect(invoke('imessage:checkAccess')).resolves.toBe(false);
  });

  it('imessage:startUpload returns FDA error when access is missing', async () => {
    imsgCheckAccess.mockReturnValueOnce(false);
    const result = await invoke('imessage:startUpload');
    expect(result).toEqual({ success: false, message: 'Full Disk Access required' });
  });

  it('imessage:startUpload returns auth error when not signed in', async () => {
    imsgCheckAccess.mockReturnValueOnce(true);
    authGetSession.mockResolvedValueOnce(null);
    const result = await invoke('imessage:startUpload');
    expect(result).toEqual({ success: false, message: 'Not authenticated' });
  });

  it('imessage:startUpload happy path forwards messages to the batch uploader', async () => {
    imsgCheckAccess.mockReturnValueOnce(true);
    authGetSession.mockResolvedValueOnce(fakeSession);
    imsgReadMessages.mockResolvedValueOnce([
      { id: 1, contact_id: 'a' },
      { id: 2, contact_id: 'a' },
      { id: 3, contact_id: 'b' },
    ]);
    batchUpload.mockResolvedValueOnce({ success: true });
    const result = await invoke('imessage:startUpload');
    expect(batchUpload).toHaveBeenCalledWith(
      'imessage',
      expect.any(Array),
      fakeSession.access_token,
      null
    );
    expect(result).toEqual({ success: true });
  });

  it('imessage:sendDirect returns success when sender resolves', async () => {
    imsgSenderSend.mockResolvedValueOnce(undefined);
    const result = await invoke('imessage:sendDirect', { to: '+15551234', message: 'hi' });
    expect(result).toEqual({ success: true });
  });

  it('imessage:sendDirect returns the error message when sender throws', async () => {
    imsgSenderSend.mockRejectedValueOnce(new Error('boom'));
    const result = await invoke('imessage:sendDirect', { to: '+15551234', message: 'hi' });
    expect(result).toEqual({ success: false, message: 'boom' });
  });
});

describe('ipc-registry: cookie channels', () => {
  beforeEach(() => {
    cookieReaderRead.mockReset();
    browserReaderInstalled.mockReset();
    browserReaderReadCookies.mockReset();
    authGetSession.mockReset();
    batchUpload.mockReset();
  });

  it('cookies:readChrome returns the reader list (empty state)', async () => {
    cookieReaderRead.mockResolvedValueOnce([]);
    await expect(invoke('cookies:readChrome')).resolves.toEqual([]);
  });

  it('cookies:upload rejects unauthenticated requests without calling uploader', async () => {
    authGetSession.mockResolvedValueOnce(null);
    const result = await invoke('cookies:upload', [{ name: 'x' }]);
    expect(result).toEqual({ success: false, message: 'Not authenticated' });
    expect(batchUpload).not.toHaveBeenCalled();
  });

  it('cookies:upload forwards to batch uploader under `chrome` integration', async () => {
    authGetSession.mockResolvedValueOnce(fakeSession);
    batchUpload.mockResolvedValueOnce({ success: true });
    const data = [{ name: 'x' }];
    const result = await invoke('cookies:upload', data);
    expect(batchUpload).toHaveBeenCalledWith('chrome', data, fakeSession.access_token, null);
    expect(result).toEqual({ success: true });
  });

  it('cookies:getInstalledBrowsers returns the browser list', async () => {
    browserReaderInstalled.mockReturnValueOnce([
      { type: 'chrome', name: 'Chrome', isInstalled: true, needsManualPassword: false },
    ]);
    const result = await invoke<Array<{ type: string }>>('cookies:getInstalledBrowsers');
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('chrome');
  });

  it('cookies:readBrowser returns cookies for the browser', async () => {
    browserReaderReadCookies.mockResolvedValueOnce([{ name: 'c1' }]);
    const result = await invoke<Array<{ name: string }>>('cookies:readBrowser', 'chrome');
    expect(result).toEqual([{ name: 'c1' }]);
  });

  it('cookies:readBrowser rethrows when the reader fails', async () => {
    browserReaderReadCookies.mockRejectedValueOnce(new Error('locked'));
    await expect(invoke('cookies:readBrowser', 'chrome')).rejects.toThrow('locked');
  });

  it('cookies:uploadBrowser blocks unauth and uses browser-typed integration on success', async () => {
    authGetSession.mockResolvedValueOnce(null);
    await expect(invoke('cookies:uploadBrowser', 'atlas', [])).resolves.toEqual({
      success: false,
      message: 'Not authenticated',
    });

    authGetSession.mockResolvedValueOnce(fakeSession);
    batchUpload.mockResolvedValueOnce({ success: true });
    const result = await invoke('cookies:uploadBrowser', 'atlas', [{ name: 'x' }]);
    expect(batchUpload).toHaveBeenCalledWith(
      'atlas',
      [{ name: 'x' }],
      fakeSession.access_token,
      null
    );
    expect(result).toEqual({ success: true });
  });
});

describe('ipc-registry: browser sync channels', () => {
  beforeEach(() => {
    browserStateSync.mockReset();
    browserStateSyncPwd.mockReset();
  });

  it('browser:sync returns the sync result on happy path', async () => {
    browserStateSync.mockResolvedValueOnce({ success: true });
    const result = await invoke('browser:sync', 'chrome');
    expect(result).toEqual({ success: true });
  });

  it('browser:sync wraps thrown errors as { success:false, message }', async () => {
    browserStateSync.mockRejectedValueOnce(new Error('oops'));
    const result = await invoke('browser:sync', 'chrome');
    expect(result).toEqual({ success: false, message: 'oops' });
  });

  it('browser:syncPasswords returns the sync result on happy path', async () => {
    browserStateSyncPwd.mockResolvedValueOnce({ success: true });
    const result = await invoke('browser:syncPasswords', 'atlas', { keychainPassword: 'pw' });
    expect(result).toEqual({ success: true });
  });

  it('browser:syncPasswords wraps thrown errors', async () => {
    browserStateSyncPwd.mockRejectedValueOnce(new Error('denied'));
    const result = await invoke('browser:syncPasswords', 'atlas');
    expect(result).toEqual({ success: false, message: 'denied' });
  });
});

describe('ipc-registry: fingerprint channels', () => {
  beforeEach(() => {
    fpCollect.mockReset();
    authGetSession.mockReset();
    batchUpload.mockReset();
  });

  it('fingerprint:collect returns the collected fingerprint', async () => {
    fpCollect.mockResolvedValueOnce({ ok: 'fp' });
    const result = await invoke('fingerprint:collect');
    expect(result).toEqual({ ok: 'fp' });
  });

  it('fingerprint:collect returns null on collector failure', async () => {
    fpCollect.mockRejectedValueOnce(new Error('no'));
    const result = await invoke('fingerprint:collect');
    expect(result).toBeNull();
  });

  it('fingerprint:upload rejects unauth without calling uploader', async () => {
    authGetSession.mockResolvedValueOnce(null);
    const result = await invoke('fingerprint:upload', { ok: 'fp' });
    expect(result).toEqual({ success: false, message: 'Not authenticated' });
    expect(batchUpload).not.toHaveBeenCalled();
  });

  it('fingerprint:upload forwards under `browser_fingerprint` integration', async () => {
    authGetSession.mockResolvedValueOnce(fakeSession);
    batchUpload.mockResolvedValueOnce({ success: true });
    const data = { ok: 'fp' };
    const result = await invoke('fingerprint:upload', data);
    expect(batchUpload).toHaveBeenCalledWith(
      'browser_fingerprint',
      data,
      fakeSession.access_token,
      null
    );
    expect(result).toEqual({ success: true });
  });
});

describe('ipc-registry: system channels', () => {
  beforeEach(() => {
    shellOpenExternal.mockClear();
    shellOpenPath.mockClear();
    requestPasskeyAutoFillPermission.mockClear();
    prepareCredentialExchangeHandoff.mockClear();
    prepareCredentialExchangeHandoff.mockResolvedValue({
      activityPath: '/tmp/credential-exchange-activity.json',
      appPath: '/Applications/Rose.app',
      pluginPath: '/Applications/Rose.app/Contents/PlugIns/PasskeyProvider.appex',
      restartedProcesses: [],
      staleLaunchServicesRecords: [],
      credentialExchangeLaunchServicesRecords: [],
    });
  });

  it('system:openFullDiskAccess opens the Privacy_AllFiles pref pane', async () => {
    const result = await invoke('system:openFullDiskAccess');
    expect(shellOpenExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
    );
    expect(result).toEqual({ success: true });
  });

  it('system:openKeychainAccess without query opens the Keychain app', async () => {
    const result = await invoke('system:openKeychainAccess');
    expect(shellOpenPath).toHaveBeenCalledWith(
      '/System/Applications/Utilities/Keychain Access.app'
    );
    expect(result).toEqual({ success: true });
  });

  it('system:openPasswordsApp opens the Passwords app', async () => {
    const result = await invoke('system:openPasswordsApp');
    expect(prepareCredentialExchangeHandoff).toHaveBeenCalledTimes(1);
    expect(shellOpenPath).toHaveBeenCalledWith('/System/Applications/Passwords.app');
    expect(result).toEqual({ success: true });
  });

  it('system:openPasswordsApp fails before opening Passwords when handoff preparation fails', async () => {
    prepareCredentialExchangeHandoff.mockRejectedValueOnce(new Error('PluginKit stale'));

    const result = await invoke('system:openPasswordsApp');

    expect(shellOpenPath).not.toHaveBeenCalledWith('/System/Applications/Passwords.app');
    expect(result).toEqual({ success: false, message: 'PluginKit stale' });
  });

  it('system:openPasswordsApp returns {success:false} when shell fails', async () => {
    shellOpenPath.mockRejectedValueOnce(new Error('x'));
    const result = await invoke('system:openPasswordsApp');
    expect(result).toEqual({ success: false, message: 'x' });
  });

  it('system:openAutoFillSettings requests credential provider permission', async () => {
    const result = await invoke('system:openAutoFillSettings');
    expect(requestPasskeyAutoFillPermission).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, enabled: true, openedSettings: false });
    expect(shellOpenExternal).not.toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.Passwords-Settings.extension'
    );
  });

  it('system:openAutoFillSettings opens AutoFill settings when Rose is not enabled', async () => {
    requestPasskeyAutoFillPermission.mockResolvedValueOnce({
      success: true,
      enabled: false,
      openedSettings: false,
    });

    const result = await invoke('system:openAutoFillSettings');

    expect(requestPasskeyAutoFillPermission).toHaveBeenCalledTimes(1);
    expect(shellOpenExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.Passwords-Settings.extension'
    );
    expect(result).toEqual({ success: true, enabled: false, openedSettings: true });
  });

  it('system:openAutoFillSettings falls back to settings when the native helper is killed', async () => {
    requestPasskeyAutoFillPermission.mockResolvedValueOnce({
      success: false,
      message: 'rose-passkey-permission exited code=null signal=SIGKILL',
      credentialExchangeEnabled: true,
    });

    const result = await invoke('system:openAutoFillSettings');

    expect(shellOpenExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.Passwords-Settings.extension'
    );
    expect(result).toEqual({
      success: true,
      enabled: false,
      openedSettings: true,
      credentialExchangeEnabled: true,
      message: 'rose-passkey-permission exited code=null signal=SIGKILL',
    });
  });

  it('system:checkAutoFillSettings reads Rose credential provider status without opening settings', async () => {
    const result = await invoke('system:checkAutoFillSettings');
    expect(getPasskeyAutoFillStatus).toHaveBeenCalledTimes(1);
    expect(shellOpenExternal).not.toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.Passwords-Settings.extension'
    );
    expect(result).toEqual({
      success: true,
      enabled: true,
      credentialExchangeEnabled: true,
    });
  });
});

describe('ipc-registry: shell channel', () => {
  beforeEach(() => {
    shellOpenExternal.mockClear();
  });

  it('shell:openExternal forwards the URL to shell.openExternal', async () => {
    const result = await invoke('shell:openExternal', 'https://example.test');
    expect(shellOpenExternal).toHaveBeenCalledWith('https://example.test');
    expect(result).toEqual({ success: true });
  });

  it('shell:openExternal returns an error when shell throws', async () => {
    shellOpenExternal.mockRejectedValueOnce(new Error('nope'));
    const result = await invoke('shell:openExternal', 'https://bad');
    expect(result).toEqual({ success: false, message: 'nope' });
  });
});

describe('ipc-registry: shortcut channels', () => {
  beforeEach(() => {
    globalShortcutRegister.mockClear();
    globalShortcutUnregister.mockClear();
  });

  it('shortcut:get returns null when nothing is saved', async () => {
    await expect(invoke('shortcut:get')).resolves.toBeNull();
  });

  it('shortcut:set persists, then shortcut:get returns the same config', async () => {
    const config = { modifiers: ['Meta', 'Shift'], key: 'K' };
    const setResult = await invoke('shortcut:set', config);
    expect(setResult).toEqual({ success: true });
    const got = await invoke('shortcut:get');
    expect(got).toEqual(config);
  });

  it('shortcut:validate returns {available:true} when globalShortcut accepts', async () => {
    globalShortcutRegister.mockReturnValueOnce(true);
    const result = await invoke('shortcut:validate', { modifiers: ['Meta'], key: 'K' });
    expect(result).toEqual({ available: true });
    expect(globalShortcutRegister).toHaveBeenCalledWith('CommandOrControl+K', expect.any(Function));
    expect(globalShortcutUnregister).toHaveBeenCalled();
  });

  it('shortcut:validate returns {available:false} on registration failure', async () => {
    globalShortcutRegister.mockReturnValueOnce(false);
    const result = await invoke('shortcut:validate', { modifiers: ['Alt'], key: 'K' });
    expect(result).toEqual({ available: false });
  });
});

describe('ipc-registry: onboarding channels', () => {
  it('onboarding:setComplete then isComplete round-trips', async () => {
    const before = await invoke('onboarding:isComplete');
    expect(before).toBe(false);
    await invoke('onboarding:setComplete', true);
    const after = await invoke('onboarding:isComplete');
    expect(after).toBe(true);
  });

  it('onboarding:setLastAuthProvider then get round-trips', async () => {
    await invoke('onboarding:setLastAuthProvider', 'supabase');
    const provider = await invoke('onboarding:getLastAuthProvider');
    expect(provider).toBe('supabase');
  });
});

describe('ipc-registry: atlas channels', () => {
  beforeEach(() => {
    atlasStore.mockReset();
    atlasHas.mockReset();
    atlasClear.mockReset();
  });

  it('atlas:storePassword proxies to the credential store', async () => {
    atlasStore.mockReturnValueOnce({ success: true });
    await expect(invoke('atlas:storePassword', 'pw')).resolves.toEqual({ success: true });
  });

  it('atlas:hasPassword returns the store boolean', async () => {
    atlasHas.mockReturnValueOnce(true);
    await expect(invoke('atlas:hasPassword')).resolves.toBe(true);
  });

  it('atlas:clearPassword returns the clear result', async () => {
    atlasClear.mockReturnValueOnce({ success: true });
    await expect(invoke('atlas:clearPassword')).resolves.toEqual({ success: true });
  });
});

describe('ipc-registry: claude channels', () => {
  beforeEach(() => {
    claudeHas.mockReset();
    claudeSync.mockReset();
    claudeSetMock.mockReset();
  });

  it('claude:hasCredentials returns the service boolean', async () => {
    claudeHas.mockReturnValueOnce(true);
    await expect(invoke('claude:hasCredentials')).resolves.toBe(true);
  });

  it('claude:syncCredentials forwards the sync result', async () => {
    claudeSync.mockResolvedValueOnce({ success: true });
    await expect(invoke('claude:syncCredentials')).resolves.toEqual({ success: true });
  });

  it('claude:syncCredentials wraps errors as {success:false, message}', async () => {
    claudeSync.mockRejectedValueOnce(new Error('cred-err'));
    await expect(invoke('claude:syncCredentials')).resolves.toEqual({
      success: false,
      message: 'cred-err',
    });
  });

  it('claude:setMockNoClaudeCode returns success and forwards the flag', async () => {
    const result = await invoke('claude:setMockNoClaudeCode', true);
    expect(claudeSetMock).toHaveBeenCalledWith(true);
    expect(result).toEqual({ success: true });
  });
});

describe('ipc-registry: whatsapp channels', () => {
  beforeEach(() => {
    authGetSession.mockReset();
    authGetSession.mockResolvedValue(fakeSession);
    waHas.mockReset();
    waPhone.mockReset();
    waConnected.mockReset();
    waConnect.mockReset();
    waDisconnect.mockReset();
    waLogout.mockReset();
    waList.mockReset();
    waAdd.mockReset();
  });

  it('whatsapp:listAccounts returns every linked account', async () => {
    const accounts = [
      { accountId: '+15550001111', connected: true },
      { accountId: '+15550002222', connected: false },
    ];
    waList.mockReturnValueOnce(accounts);
    await expect(invoke('whatsapp:listAccounts')).resolves.toEqual(accounts);
  });

  it('whatsapp:addAccount pairs one more account, guarded by the machine session', async () => {
    waAdd.mockResolvedValueOnce(undefined);
    await expect(invoke('whatsapp:addAccount')).resolves.toEqual({ success: true });
    expect(waAdd).toHaveBeenCalledWith({ onQRCode: expect.any(Function) });

    authGetSession.mockReset();
    authGetSession.mockResolvedValue(null);
    const refused = await invoke<{ success: boolean }>('whatsapp:addAccount');
    expect(refused.success).toBe(false);
    expect(waAdd).toHaveBeenCalledTimes(1);
  });

  it('whatsapp:logout and isConnected scope to one account id; none means all/any', async () => {
    waLogout.mockResolvedValue(undefined);
    await invoke('whatsapp:logout', '+15550001111');
    expect(waLogout).toHaveBeenLastCalledWith('+15550001111');
    await invoke('whatsapp:logout');
    expect(waLogout).toHaveBeenLastCalledWith(undefined);
    await invoke('whatsapp:logout', 42);
    expect(waLogout).toHaveBeenLastCalledWith(undefined);

    waConnected.mockReturnValue(true);
    await invoke('whatsapp:isConnected', '+15550002222');
    expect(waConnected).toHaveBeenLastCalledWith('+15550002222');
  });

  it('whatsapp:hasCredentials returns the service boolean', async () => {
    waHas.mockReturnValueOnce(true);
    await expect(invoke('whatsapp:hasCredentials')).resolves.toBe(true);
  });

  it('whatsapp:getLinkedPhoneNumber returns the number or null', async () => {
    waPhone.mockReturnValueOnce('+15551234');
    await expect(invoke('whatsapp:getLinkedPhoneNumber')).resolves.toBe('+15551234');
    waPhone.mockReturnValueOnce(null);
    await expect(invoke('whatsapp:getLinkedPhoneNumber')).resolves.toBeNull();
  });

  it('whatsapp:isConnected returns the service boolean', async () => {
    waConnected.mockReturnValueOnce(true);
    await expect(invoke('whatsapp:isConnected')).resolves.toBe(true);
  });

  it('whatsapp:connect returns success and disconnect/logout behave symmetrically', async () => {
    waConnect.mockResolvedValueOnce(undefined);
    await expect(invoke('whatsapp:connect')).resolves.toEqual({ success: true });

    waDisconnect.mockResolvedValueOnce(undefined);
    await expect(invoke('whatsapp:disconnect')).resolves.toEqual({ success: true });

    waLogout.mockResolvedValueOnce(undefined);
    await expect(invoke('whatsapp:logout')).resolves.toEqual({ success: true });
  });

  it('whatsapp:connect wraps errors as {success:false, error}', async () => {
    waConnect.mockRejectedValueOnce(new Error('qr-timeout'));
    const result = await invoke<{ success: boolean; error?: string }>('whatsapp:connect');
    expect(result.success).toBe(false);
    expect(result.error).toBe('qr-timeout');
  });

  it('whatsapp:connect refuses to dial WhatsApp when there is no machine session', async () => {
    // Pairing uploads history to the backend, so an unauthenticated connect must
    // fail BEFORE a QR is ever shown — otherwise the user pairs their phone and
    // every later flush is silently dropped for lack of a session.
    authGetSession.mockReset();
    authGetSession.mockResolvedValue(null);

    const result = await invoke<{ success: boolean; error?: string }>('whatsapp:connect');
    expect(result.success).toBe(false);
    expect(waConnect).not.toHaveBeenCalled();
  });

  it('whatsapp:disconnect wraps errors as {success:false, error}', async () => {
    waDisconnect.mockRejectedValueOnce(new Error('socket-stuck'));
    const result = await invoke<{ success: boolean; error?: string }>('whatsapp:disconnect');
    expect(result.success).toBe(false);
    expect(result.error).toBe('socket-stuck');
  });

  it('whatsapp:logout wraps errors as {success:false, error}', async () => {
    waLogout.mockRejectedValueOnce(new Error('creds-locked'));
    const result = await invoke<{ success: boolean; error?: string }>('whatsapp:logout');
    expect(result.success).toBe(false);
    expect(result.error).toBe('creds-locked');
  });

  it('falls back to a generic message when the thrown error carries no message', async () => {
    // getErrorMessage() passes an Error's own (empty) message straight through,
    // so the `|| default` arm is what keeps the renderer from showing a blank
    // error string.
    waDisconnect.mockRejectedValueOnce(new Error(''));
    await expect(
      invoke<{ success: boolean; error?: string }>('whatsapp:disconnect')
    ).resolves.toEqual({ success: false, error: 'Disconnect failed' });

    waLogout.mockRejectedValueOnce(new Error(''));
    await expect(invoke<{ success: boolean; error?: string }>('whatsapp:logout')).resolves.toEqual({
      success: false,
      error: 'Logout failed',
    });
  });
});

describe('ipc-registry: telegram channels (non-backend)', () => {
  beforeEach(() => {
    authGetSession.mockReset();
    authGetSession.mockResolvedValue(fakeSession);
    tgHasSession.mockReset();
    tgHasApi.mockReset();
    tgConnected.mockReset();
    tgSyncHistorical.mockReset();
    tgSubmitCode.mockReset();
    tgSubmitPassword.mockReset();
    tgCancelAuth.mockReset();
  });

  it('telegram:hasSession returns the service boolean', async () => {
    tgHasSession.mockReturnValueOnce(true);
    await expect(invoke('telegram:hasSession')).resolves.toBe(true);
  });

  it('telegram:hasApiCredentials returns the service boolean', async () => {
    tgHasApi.mockReturnValueOnce(true);
    await expect(invoke('telegram:hasApiCredentials')).resolves.toBe(true);
  });

  it('telegram:isConnected returns the service boolean', async () => {
    tgConnected.mockReturnValueOnce(true);
    await expect(invoke('telegram:isConnected')).resolves.toBe(true);
  });

  it('telegram:syncHistorical returns {success,count}', async () => {
    tgSyncHistorical.mockResolvedValueOnce(42);
    await expect(invoke('telegram:syncHistorical', 50)).resolves.toEqual({
      success: true,
      count: 42,
    });
  });

  it('telegram:syncHistorical wraps errors as {success:false, error}', async () => {
    tgSyncHistorical.mockRejectedValueOnce(new Error('net'));
    const result = await invoke<{ success: boolean; error?: string }>(
      'telegram:syncHistorical',
      50
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('net');
  });

  it('telegram:submitCode / submitPassword / cancelAuth return {success:true} on happy path', async () => {
    await expect(invoke('telegram:submitCode', '12345')).resolves.toEqual({ success: true });
    await expect(invoke('telegram:submitPassword', 'pw')).resolves.toEqual({ success: true });
    await expect(invoke('telegram:cancelAuth')).resolves.toEqual({ success: true });
    expect(tgSubmitCode).toHaveBeenCalledWith('12345');
    expect(tgSubmitPassword).toHaveBeenCalledWith('pw');
    expect(tgCancelAuth).toHaveBeenCalled();
  });

  it('telegram:submitCode wraps errors as {success:false, error}', async () => {
    tgSubmitCode.mockImplementationOnce(() => {
      throw new Error('bad-code');
    });
    const result = await invoke<{ success: boolean; error?: string }>('telegram:submitCode', 'x');
    expect(result.success).toBe(false);
    expect(result.error).toBe('bad-code');
  });

  it('telegram:disconnect and telegram:logout return {success:true}', async () => {
    await expect(invoke('telegram:disconnect')).resolves.toEqual({ success: true });
    await expect(invoke('telegram:logout')).resolves.toEqual({ success: true });
  });
});

// ---------------------------------------------------------------------------
// Backend boundary coverage: telegram:connectWithExistingSession is the only
// flow in registry.ts that makes a real fetch() call — it POSTs to the backend
// to register the integration. Capture and assert on URL/method/headers.
// ---------------------------------------------------------------------------
describe('ipc-registry: telegram backend boundary', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    clearFetchCaptures();
    tgConnectExisting.mockReset();
    authGetSession.mockReset();
    integrationCacheInvalidate.mockReset();
    tgSyncHistorical.mockReset();
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  it('telegram:connectWithExistingSession skips backend when service returns false', async () => {
    restoreFetch = installFetchCapture({});
    tgConnectExisting.mockResolvedValueOnce(false);
    authGetSession.mockResolvedValueOnce(fakeSession);

    const result = await invoke('telegram:connectWithExistingSession');

    expect(result).toEqual({ success: false });
    expect(fetchCaptures).toHaveLength(0);
  });

  it('telegram:connectWithExistingSession skips backend when no session', async () => {
    restoreFetch = installFetchCapture({});
    tgConnectExisting.mockResolvedValueOnce(true);
    authGetSession.mockResolvedValueOnce(null);

    const result = await invoke('telegram:connectWithExistingSession');

    expect(result).toEqual({ success: false, error: 'Not authenticated' });
    expect(tgConnectExisting).not.toHaveBeenCalled();
    expect(fetchCaptures).toHaveLength(0);
  });

  it('telegram:connectWithExistingSession POSTs to /api/integrations/telegram/connect with bearer auth', async () => {
    restoreFetch = installFetchCapture({
      '/api/integrations/telegram/connect': () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    tgConnectExisting.mockResolvedValueOnce(true);
    authGetSession.mockResolvedValue(fakeSession);
    tgSyncHistorical.mockResolvedValueOnce(0);

    const result = await invoke('telegram:connectWithExistingSession');

    expect(result).toEqual({ success: true });
    expect(fetchCaptures).toHaveLength(1);
    const call = fetchCaptures[0];
    expect(call.url).toBe('https://backend.test/api/integrations/telegram/connect');
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${fakeSession.access_token}`);
    expect(call.headers['content-type']).toBe('application/json');
    expect(integrationCacheInvalidate).toHaveBeenCalled();
  });

  it('telegram:connectWithExistingSession still returns {success:true} when backend rejects', async () => {
    restoreFetch = installFetchCapture({
      '/api/integrations/telegram/connect': () => new Response('server err', { status: 500 }),
    });
    tgConnectExisting.mockResolvedValueOnce(true);
    authGetSession.mockResolvedValue(fakeSession);

    const result = await invoke('telegram:connectWithExistingSession');

    // Observable contract: the IPC reply still shows the session-level success.
    // Backend failure is logged but not surfaced to the renderer.
    expect(result).toEqual({ success: true });
    expect(fetchCaptures).toHaveLength(1);
    expect(fetchCaptures[0].responseStatus).toBe(500);
    expect(integrationCacheInvalidate).not.toHaveBeenCalled();
  });
});
