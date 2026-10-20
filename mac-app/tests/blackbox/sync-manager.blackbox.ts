/**
 * Blackbox tests for the sync-manager domain.
 *
 * Domain entry: main/services/sync/index.ts (SyncManager, IntegrationCache).
 * SyncManager orchestrates every per-platform sync service (iMessage, Telegram,
 * WhatsApp, browser state), the IMessage queue poller, and the shared
 * IntegrationCache which is the only component in the domain that hits the
 * backend API (GET {apiUrl}/api/integrations).
 *
 * Test strategy:
 *   - Stub Electron + native modules up front so `import` of SyncManager is safe
 *     in the jsdom-on-Node test environment.
 *   - Mock the domain's per-platform sync modules as external boundaries — the
 *     observable behavior of SyncManager is which of those boundaries it invokes
 *     and with what arguments.
 *   - Exercise IntegrationCache for real against a captured fetch so the one
 *     network boundary in this domain (GET /api/integrations) is asserted on
 *     URL, method, and Authorization header.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubAllElectron } from './electron-stubs';
import { installFetchCapture, fetchCaptures, clearFetchCaptures } from './fetch-capture';

stubAllElectron();

// ---------------------------------------------------------------------------
// Mock the shared config + logger before any domain import so `import { config }`
// resolves to a deterministic URL and log helpers are no-ops.
// ---------------------------------------------------------------------------

vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'https://backend.test',
    supabase: { url: 'https://supabase.test', anonKey: 'anon-test' },
    encryptionKey: 'test-key',
    isDev: true,
  },
}));

vi.mock('../../main/base/logger', () => ({
  logConsole: vi.fn(),
  logConsoleError: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock external boundaries (per-platform sync services + queue service + auth).
// Each mock is a vi.fn so tests can assert on interactions via the shared
// observable surface (method called / not called, arguments forwarded).
// ---------------------------------------------------------------------------

vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: vi.fn(),
  },
}));

vi.mock('../../main/services/iMessageSync', () => ({
  IMessageSync: {
    sync: vi.fn(async () => {}),
    startRealTimeSync: vi.fn(),
    stopRealTimeSync: vi.fn(),
  },
}));

vi.mock('../../main/services/browserStateSync', () => ({
  BrowserStateSync: {
    sync: vi.fn(async () => {}),
  },
}));

vi.mock('../../main/services/claudeCredentialSync', () => ({
  ClaudeCredentialSync: {
    syncExistingCredentialsIfChanged: vi.fn(async () => ({ success: true })),
  },
}));

vi.mock('../../main/services/gptCredentialSync', () => ({
  CODEX_AUTH_PATH: '/tmp/rose-test-codex-auth.json',
  GptCredentialSync: {
    syncExistingCredentialsIfChanged: vi.fn(async () => ({ success: true })),
  },
}));

vi.mock('../../main/services/userDataSync', () => ({
  UserDataSync: {
    sync: vi.fn(async () => []),
    startRealTimeSync: vi.fn(async () => {}),
    stopRealTimeSync: vi.fn(),
  },
}));

vi.mock('../../main/services/messaging/platforms/telegram/TelegramSync', () => ({
  TelegramSync: {
    hasSession: vi.fn(() => false),
    hasApiCredentials: vi.fn(() => false),
    isConnected: vi.fn(() => false),
    connectWithExistingSession: vi.fn(async () => false),
    syncHistorical: vi.fn(async () => 0),
    disconnect: vi.fn(async () => {}),
  },
}));

vi.mock('../../main/services/messaging/platforms/whatsapp/WhatsAppSync', () => ({
  WhatsAppSync: {
    hasCredentials: vi.fn(() => false),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  },
}));

vi.mock('../../main/services/IMessageQueueService', () => ({
  IMessageQueueService: {
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../../main/services/phoneMirroring', () => ({
  PhoneMirroring: {
    start: vi.fn(() => true),
    stop: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports — after all mocks. SyncManager + IntegrationCache are the public
// entrypoints re-exported from main/services/sync/index.ts.
// ---------------------------------------------------------------------------

import { SyncManager, IntegrationCache } from '../../main/services/sync';
import { AuthService } from '../../main/services/auth';
import { IMessageSync } from '../../main/services/iMessageSync';
import { BrowserStateSync } from '../../main/services/browserStateSync';
import { ClaudeCredentialSync } from '../../main/services/claudeCredentialSync';
import { GptCredentialSync } from '../../main/services/gptCredentialSync';
import { UserDataSync } from '../../main/services/userDataSync';
import { TelegramSync } from '../../main/services/messaging/platforms/telegram/TelegramSync';
import { WhatsAppSync } from '../../main/services/messaging/platforms/whatsapp/WhatsAppSync';
import { IMessageQueueService } from '../../main/services/IMessageQueueService';
import { PhoneMirroring } from '../../main/services/phoneMirroring';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_SESSION = {
  access_token: 'access-test-token',
  refresh_token: 'refresh-test-token',
  expires_at: Date.now() + 60 * 60 * 1000,
  user: { id: 'u-1' },
} as unknown as Awaited<ReturnType<typeof AuthService.getSession>>;

/**
 * Build a JSON Response suitable for the fetch-capture responder map.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Integration-cache responder helper — the cache hits /api/integrations with
 * a bearer token and expects `{ integrations: [...] }`. Build a responder that
 * returns the requested connected names.
 */
function integrationsResponder(names: string[]) {
  return () =>
    jsonResponse({
      integrations: names.map((name) => ({ name, status: 'CONNECTED' })),
    });
}

/**
 * SyncManager makes many /api/integrations calls per run; IntegrationCache
 * dedupes them into a single outbound fetch. Tests assert on that single call.
 */
function integrationCalls() {
  return fetchCaptures.filter((c) => c.url.includes('/api/integrations'));
}

/**
 * Reset the module-private state inside SyncManager / IntegrationCache between
 * tests. Both classes are static singletons, so without this each test inherits
 * the previous test's state and the asserted behavior drifts.
 */
async function resetSyncManagerState(): Promise<void> {
  // Stop periodic dispatcher + set isRunning=false. Safe to call when not running.
  await SyncManager.stopAll();
  IntegrationCache.invalidate();
  vi.clearAllMocks();
  clearFetchCaptures();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sync-manager blackbox', () => {
  let restoreFetch: () => void = () => {};

  beforeEach(async () => {
    await resetSyncManagerState();
  });

  afterEach(() => {
    restoreFetch();
    restoreFetch = () => {};
  });

  // -------------------------------------------------------------------------
  // Auth boundary
  // -------------------------------------------------------------------------

  describe('auth boundary', () => {
    it('startAll skips all sync work when there is no session', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(null);
      restoreFetch = installFetchCapture({});

      await SyncManager.startAll();

      // No per-platform sync should run.
      expect(vi.mocked(IMessageSync.sync)).not.toHaveBeenCalled();
      expect(vi.mocked(BrowserStateSync.sync)).not.toHaveBeenCalled();
      // No backend fetch to /api/integrations should happen when unauthenticated.
      expect(integrationCalls()).toHaveLength(0);
      // Queue polling + realtime iMessage watcher still start (they self-gate
      // internally on integration status + permissions).
      expect(vi.mocked(IMessageQueueService.start)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(IMessageSync.startRealTimeSync)).toHaveBeenCalledTimes(1);
      // SyncManager records itself as running.
      expect(SyncManager.isActive()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — connected integrations trigger the matching sync services.
  // -------------------------------------------------------------------------

  describe('startAll happy path', () => {
    it('runs startup syncs for every connected integration and starts queue + realtime', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['imessage', 'chrome']),
      });

      await SyncManager.startAll();

      // Chrome state has one startup owner: BrowserStateSync includes cookies.
      expect(vi.mocked(IMessageSync.sync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(BrowserStateSync.sync)).toHaveBeenCalledTimes(1);
      expect(
        vi.mocked(ClaudeCredentialSync.syncExistingCredentialsIfChanged)
      ).not.toHaveBeenCalled();
      expect(vi.mocked(GptCredentialSync.syncExistingCredentialsIfChanged)).not.toHaveBeenCalled();

      // Realtime watchers + queue poller start unconditionally.
      expect(vi.mocked(IMessageSync.startRealTimeSync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(IMessageQueueService.start)).toHaveBeenCalledTimes(1);
      // The attached-iPhone presence loop follows the same lifecycle.
      expect(vi.mocked(PhoneMirroring.start)).toHaveBeenCalledTimes(1);

      // Telegram + WhatsApp not connected, so no realtime connect call.
      expect(vi.mocked(TelegramSync.connectWithExistingSession)).not.toHaveBeenCalled();
      expect(vi.mocked(WhatsAppSync.connect)).not.toHaveBeenCalled();

      expect(SyncManager.isActive()).toBe(true);
    });

    it('is idempotent — second startAll while running is a no-op', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['imessage']),
      });

      await SyncManager.startAll();
      vi.clearAllMocks();
      clearFetchCaptures();

      await SyncManager.startAll();

      // Second call must not re-trigger any sync side effects.
      expect(vi.mocked(IMessageSync.sync)).not.toHaveBeenCalled();
      expect(vi.mocked(IMessageSync.startRealTimeSync)).not.toHaveBeenCalled();
      expect(vi.mocked(IMessageQueueService.start)).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });

    it('connects Telegram realtime when session + API creds + integration all present', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      vi.mocked(TelegramSync.hasSession).mockReturnValue(true);
      vi.mocked(TelegramSync.hasApiCredentials).mockReturnValue(true);
      vi.mocked(TelegramSync.connectWithExistingSession).mockResolvedValue(true);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['telegram']),
      });

      await SyncManager.startAll();

      expect(vi.mocked(TelegramSync.connectWithExistingSession)).toHaveBeenCalledTimes(1);
      // After connect, historical sync is kicked off.
      expect(vi.mocked(TelegramSync.syncHistorical)).toHaveBeenCalledTimes(1);
    });

    it('connects WhatsApp realtime when credentials + integration both present', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      vi.mocked(WhatsAppSync.hasCredentials).mockReturnValue(true);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['whatsapp']),
      });

      await SyncManager.startAll();

      expect(vi.mocked(WhatsAppSync.connect)).toHaveBeenCalledTimes(1);
      // connect was called with an onQRCode callback.
      const call = vi.mocked(WhatsAppSync.connect).mock.calls[0][0];
      expect(typeof call?.onQRCode).toBe('function');
    });

    it('runs startup compute sync for connected Claude and GPT subscriptions', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['claude_code', 'gpt_code']),
      });

      await SyncManager.startAll();

      expect(
        vi.mocked(ClaudeCredentialSync.syncExistingCredentialsIfChanged)
      ).toHaveBeenCalledTimes(1);
      expect(vi.mocked(GptCredentialSync.syncExistingCredentialsIfChanged)).toHaveBeenCalledTimes(
        1
      );
    });

    it('runs startup user-data sync and realtime watchers for connected document providers', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['apple_notes', 'obsidian']),
      });

      await SyncManager.startAll();

      expect(vi.mocked(UserDataSync.sync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(UserDataSync.sync).mock.calls[0][0]).toEqual(
        new Set(['apple_notes', 'obsidian'])
      );
      expect(vi.mocked(UserDataSync.startRealTimeSync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(UserDataSync.startRealTimeSync).mock.calls[0][0]).toEqual(
        new Set(['apple_notes', 'obsidian'])
      );
    });
  });

  // -------------------------------------------------------------------------
  // Empty state — authenticated but no integrations connected.
  // -------------------------------------------------------------------------

  describe('empty state', () => {
    it('skips all per-platform syncs when no integrations are connected', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder([]),
      });

      await SyncManager.startAll();

      expect(vi.mocked(IMessageSync.sync)).not.toHaveBeenCalled();
      expect(vi.mocked(BrowserStateSync.sync)).not.toHaveBeenCalled();
      expect(vi.mocked(TelegramSync.connectWithExistingSession)).not.toHaveBeenCalled();
      expect(vi.mocked(WhatsAppSync.connect)).not.toHaveBeenCalled();
      expect(
        vi.mocked(ClaudeCredentialSync.syncExistingCredentialsIfChanged)
      ).not.toHaveBeenCalled();
      expect(vi.mocked(GptCredentialSync.syncExistingCredentialsIfChanged)).not.toHaveBeenCalled();
      expect(vi.mocked(UserDataSync.sync)).not.toHaveBeenCalled();

      // Queue polling + iMessage realtime watcher still start.
      expect(vi.mocked(IMessageQueueService.start)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(IMessageSync.startRealTimeSync)).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Error state — /api/integrations returns 500.
  // -------------------------------------------------------------------------

  describe('error state', () => {
    it('handles backend /api/integrations 500 without crashing startAll', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': () => jsonResponse({ error: 'boom' }, 500),
      });

      await expect(SyncManager.startAll()).resolves.toBeUndefined();

      // Empty integration set means no sync work.
      expect(vi.mocked(IMessageSync.sync)).not.toHaveBeenCalled();
      expect(vi.mocked(BrowserStateSync.sync)).not.toHaveBeenCalled();

      // Queue + realtime still initialize so user recovery is possible.
      expect(vi.mocked(IMessageQueueService.start)).toHaveBeenCalledTimes(1);
      expect(SyncManager.isActive()).toBe(true);
    });

    it('an individual platform sync throwing does not abort the other startup syncs', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      vi.mocked(IMessageSync.sync).mockRejectedValueOnce(new Error('imessage disk error'));
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['imessage', 'chrome']),
      });

      await expect(SyncManager.startAll()).resolves.toBeUndefined();

      // Other connected platforms still ran.
      expect(vi.mocked(BrowserStateSync.sync)).toHaveBeenCalledTimes(1);
    });

    it('syncNow() includes compute when a compute integration is connected', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['claude_code']),
      });

      await SyncManager.syncNow();

      expect(
        vi.mocked(ClaudeCredentialSync.syncExistingCredentialsIfChanged)
      ).toHaveBeenCalledTimes(1);
      expect(vi.mocked(GptCredentialSync.syncExistingCredentialsIfChanged)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Boundary capture — /api/integrations is the only outbound fetch.
  // -------------------------------------------------------------------------

  describe('boundary capture (/api/integrations)', () => {
    it('hits GET {apiUrl}/api/integrations exactly once per startAll with bearer auth', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['imessage']),
      });

      await SyncManager.startAll();

      // IntegrationCache is hit multiple times within one startAll (startup +
      // realtime watchers), but it dedupes in-flight requests and caches the
      // result for 30s, so the outbound network call happens exactly once.
      const calls = integrationCalls();
      expect(calls).toHaveLength(1);

      const call = calls[0];
      expect(call.url).toBe('https://backend.test/api/integrations');
      expect(call.method).toBe('GET');
      expect(call.headers.authorization).toBe(`Bearer ${FAKE_SESSION!.access_token}`);
      expect(call.body).toBeNull();
    });

    it('IntegrationCache.isConnected forwards the stored session token', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['telegram']),
      });

      const connected = await IntegrationCache.isConnected('telegram');
      const missing = await IntegrationCache.isConnected('whatsapp');

      expect(connected).toBe(true);
      expect(missing).toBe(false);

      // Two isConnected calls within 30s share one underlying network request.
      const calls = integrationCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('GET');
      expect(calls[0].headers.authorization).toBe(`Bearer ${FAKE_SESSION!.access_token}`);
    });

    it('IntegrationCache skips the network call entirely when unauthenticated', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(null);
      restoreFetch = installFetchCapture({});

      const connected = await IntegrationCache.getConnected();

      expect(connected.size).toBe(0);
      expect(fetchCaptures).toHaveLength(0);
    });

    it('IntegrationCache.invalidate forces a re-fetch on the next read', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['chrome']),
      });

      await IntegrationCache.getConnected();
      IntegrationCache.invalidate();
      await IntegrationCache.getConnected();

      expect(integrationCalls()).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // stopAll + syncNow — other public entrypoints of SyncManager.
  // -------------------------------------------------------------------------

  describe('stopAll', () => {
    it('stops every running sync surface and flips isActive to false', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['imessage']),
      });
      await SyncManager.startAll();

      await SyncManager.stopAll();

      expect(vi.mocked(IMessageSync.stopRealTimeSync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(UserDataSync.stopRealTimeSync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(TelegramSync.disconnect)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(WhatsAppSync.disconnect)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(IMessageQueueService.stop)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(PhoneMirroring.stop)).toHaveBeenCalledTimes(1);
      expect(SyncManager.isActive()).toBe(false);
    });
  });

  describe('syncNow', () => {
    it('syncNow("imessage") runs only iMessage when the integration is connected', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['imessage']),
      });

      await SyncManager.syncNow('imessage');

      expect(vi.mocked(IMessageSync.sync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(BrowserStateSync.sync)).not.toHaveBeenCalled();
    });

    it('syncNow("telegram") skips when integration is not connected', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder([]),
      });

      await SyncManager.syncNow('telegram');

      expect(vi.mocked(TelegramSync.syncHistorical)).not.toHaveBeenCalled();
    });

    it('syncNow() with no arg fans out to every connected platform', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder(['imessage', 'chrome']),
      });

      await SyncManager.syncNow();

      expect(vi.mocked(IMessageSync.sync)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(BrowserStateSync.sync)).toHaveBeenCalledTimes(1);
    });

    it('syncNow() without any session is a safe no-op', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(null);
      restoreFetch = installFetchCapture({});

      await SyncManager.syncNow();

      expect(vi.mocked(IMessageSync.sync)).not.toHaveBeenCalled();
      expect(vi.mocked(BrowserStateSync.sync)).not.toHaveBeenCalled();
      expect(fetchCaptures).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // State transition — isActive reflects start / stop / start again.
  // -------------------------------------------------------------------------

  describe('state transitions', () => {
    it('isActive moves false -> true -> false across startAll/stopAll', async () => {
      vi.mocked(AuthService.getSession).mockResolvedValue(FAKE_SESSION);
      restoreFetch = installFetchCapture({
        '/api/integrations': integrationsResponder([]),
      });

      expect(SyncManager.isActive()).toBe(false);
      await SyncManager.startAll();
      expect(SyncManager.isActive()).toBe(true);
      await SyncManager.stopAll();
      expect(SyncManager.isActive()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-account write protection
// ---------------------------------------------------------------------------

/**
 * Every sync below uploads data harvested from THIS machine — the operator's
 * iMessage history, consolidated browser state, and compute credentials —
 * authenticated as the current session. While an admin is impersonating, that
 * session belongs to the TARGET user, so an unguarded sync writes the operator's
 * personal data into someone else's account. That is silent cross-account
 * corruption that cannot be un-written, so nothing may leave the machine.
 *
 * The signal is the server-signed RFC 8693 `act` (actor) claim the backend
 * stamps onto impersonated sessions.
 */
describe('sync-manager refuses to sync while impersonating', () => {
  /** Build an unsigned JWT whose payload carries the given claims. */
  const jwtWith = (claims: Record<string, unknown>): string => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
  };

  const impersonatedSession = {
    access_token: jwtWith({ sub: 'target-user', act: { sub: 'admin-user' } }),
    refresh_token: 'r',
    expires_at: Date.now() + 60 * 60 * 1000,
    user: { id: 'target-user' },
  } as unknown as Awaited<ReturnType<typeof AuthService.getSession>>;

  const ownSession = {
    access_token: jwtWith({ sub: 'admin-user' }),
    refresh_token: 'r',
    expires_at: Date.now() + 60 * 60 * 1000,
    user: { id: 'admin-user' },
  } as unknown as Awaited<ReturnType<typeof AuthService.getSession>>;

  let restoreFetch: (() => void) | null = null;

  beforeEach(async () => {
    // Static singletons: without this each case inherits the previous cache.
    await resetSyncManagerState();
    // Every platform under test reports CONNECTED, so the only thing that can
    // stop a sync in these cases is the impersonation guard itself.
    restoreFetch = installFetchCapture({
      '/api/integrations': integrationsResponder(['imessage', 'chrome', 'claude_code', 'gpt_code']),
    });
  });

  afterEach(async () => {
    await SyncManager.stopAll();
    restoreFetch?.();
    restoreFetch = null;
  });

  it('uploads nothing from any platform while impersonating', async () => {
    vi.mocked(AuthService.getSession).mockResolvedValue(impersonatedSession);

    await SyncManager.syncNow('imessage');
    await SyncManager.syncNow('browserState');
    await SyncManager.syncNow('compute');

    expect(IMessageSync.sync).not.toHaveBeenCalled();
    expect(BrowserStateSync.sync).not.toHaveBeenCalled();
    expect(ClaudeCredentialSync.syncExistingCredentialsIfChanged).not.toHaveBeenCalled();
    expect(GptCredentialSync.syncExistingCredentialsIfChanged).not.toHaveBeenCalled();
  });

  it('does not arm real-time watchers while impersonating', async () => {
    vi.mocked(AuthService.getSession).mockResolvedValue(impersonatedSession);

    await SyncManager.startAll();

    expect(IMessageSync.startRealTimeSync).not.toHaveBeenCalled();
    expect(IMessageQueueService.start).not.toHaveBeenCalled();
    // An operator's Mac must not attach its iPhone to the viewed account.
    expect(PhoneMirroring.start).not.toHaveBeenCalled();
    expect(SyncManager.isActive()).toBe(false);
  });

  it('still syncs normally on the operator OWN account', async () => {
    vi.mocked(AuthService.getSession).mockResolvedValue(ownSession);

    await SyncManager.syncNow('imessage');

    expect(IMessageSync.sync).toHaveBeenCalled();
  });
});
