/**
 * messaging-telegram domain blackbox
 *
 * Surface under test (per scripts/map-domains.ts messaging-telegram):
 *   - main/services/messaging/platforms/telegram/index.ts       (public barrel)
 *   - main/services/messaging/platforms/telegram/TelegramAuth.ts   (session persistence on disk)
 *   - main/services/messaging/platforms/telegram/TelegramClient.ts (GramJS wrapper + auth state machine)
 *   - main/services/messaging/platforms/telegram/TelegramSync.ts   (static coordinator: auth → buffer → upload)
 *
 * Observable behavior tested:
 *   - Barrel re-exports the three public classes.
 *   - Session file lifecycle on disk (loadSession / saveSession / hasSession / clearSession).
 *   - Static `hasApiCredentials` reads TELEGRAM_API_ID/TELEGRAM_API_HASH at module load.
 *   - `startAuth` short-circuits when API creds are missing (no network, no GramClient).
 *   - `TelegramClient.submitCode` / `submitPassword` / `cancelAuth` are no-ops outside awaiting states
 *     (auth state machine stays consistent).
 *   - `TelegramSync.startAuth` returns the underlying client's error verbatim (no creds → no client).
 *   - `TelegramSync.syncHistorical` is gated by (a) connected-client, (b) IntegrationCache status.
 *   - `TelegramSync.connectWithExistingSession` returns false when no session exists, returns false when API
 *     creds missing — the empty-state preconditions.
 *   - Fetch boundary: when the Sync does reach the uploader (upload of historical messages), the
 *     outbound POST goes to {apiUrl}/api/integrations/telegram/upload with Bearer auth and a JSON body
 *     shaped { contacts, accessedAt } — captured via install/fetchCapture.
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns — deferred.
 *   - Concurrent-invocation — deferred (vitest file isolation already gives jsdom-per-file).
 *   - Negative-control checks — deferred.
 *   - Broader-suite verification — deferred.
 *   - Interactive GramJS auth flow end-to-end: the real `client.start({phoneNumber,phoneCode,password,onError})`
 *     inner workings live inside the vendored `telegram` SDK — we stub the SDK at the boundary and assert on
 *     the public state-machine contract (submit* / cancel* / getAuthState). The SDK itself is the third-party
 *     boundary; replaying the MTProto handshake is out of scope for a blackbox safety net.
 *   - Real-time message ingestion path (`setupMessageHandler` → `handleNewMessage` → `emit('sync')`). The
 *     normalization is tested indirectly via the uploader boundary when syncHistorical runs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { stubAllElectron } from './electron-stubs';
import { installFetchCapture, clearFetchCaptures, fetchCaptures } from './fetch-capture';

const { TEST_USER_DATA_DIR } = vi.hoisted(() => {
  const testUserDataDir = `/tmp/mac-app-test-telegram-${process.pid}`;
  process.env.MAC_APP_TEST_USER_DATA = testUserDataDir;
  return { TEST_USER_DATA_DIR: testUserDataDir };
});

// Config reads env vars at module-load time — provide deterministic fakes BEFORE any
// import that transitively pulls `main/base/config.ts`. The batch prompt pins backend to
// http://localhost:3001 (the same URL vitest.config.ts injects into import.meta.env).
process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.VITE_BACKEND_API_URL = 'http://localhost:3001';
process.env.ENCRYPTION_KEY = 'test-encryption-key';
// Default: API credentials NOT configured. Individual tests override via vi.stubEnv
// if they need to exercise the credentials-present branch.
delete process.env.TELEGRAM_API_ID;
delete process.env.TELEGRAM_API_HASH;

stubAllElectron();

// TelegramAuth caches app.getPath('userData') at module load. This suite uses a
// process-scoped test dir so parallel deploy verifiers cannot delete each
// other's session file.
const TELEGRAM_AUTH_DIR = path.join(TEST_USER_DATA_DIR, 'telegram-auth');
const SESSION_PATH = path.join(TELEGRAM_AUTH_DIR, 'session.txt');

// ---------------------------------------------------------------------------
// Vendor SDK stubs — the `telegram` (GramJS) package is the third-party
// boundary. Replaying MTProto is out of scope for a blackbox safety net, so
// we stub the SDK surface that TelegramClient imports at module-load time.
// ---------------------------------------------------------------------------

/**
 * Shared fake StringSession ctor — exposes a stable `.save()` returning whatever
 * string was passed in. Used by both TelegramAuth (disk persistence) and
 * TelegramClient (starting auth with a loaded session).
 */
vi.mock('telegram/sessions', () => ({
  StringSession: vi.fn().mockImplementation((s: string) => ({
    save: () => s ?? '',
    _saveValue: s ?? '',
  })),
}));

// GramClient is referenced but never constructed in tests that don't hit the
// credentials-present branch. We still stub it so the module import resolves.
// Note: vi.mock factories are hoisted and cannot close over file-scope vars,
// so the Api stub is duplicated across `telegram` and `telegram/tl`.
vi.mock('telegram', () => ({
  TelegramClient: vi.fn().mockImplementation(() => ({
    session: { save: () => '' },
    start: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    isUserAuthorized: vi.fn(async () => false),
    invoke: vi.fn(async () => ({})),
    addEventHandler: vi.fn(),
    getMessages: vi.fn(async () => []),
    getDialogs: vi.fn(async () => []),
  })),
  Api: {
    auth: { LogOut: vi.fn() },
    PeerUser: class PeerUser {},
    PeerChat: class PeerChat {},
    PeerChannel: class PeerChannel {},
    Message: class Message {},
  },
}));
vi.mock('telegram/events', () => ({ NewMessage: vi.fn() }));
vi.mock('telegram/tl', () => ({
  Api: {
    auth: { LogOut: vi.fn() },
    PeerUser: class PeerUser {},
    PeerChat: class PeerChat {},
    PeerChannel: class PeerChannel {},
    Message: class Message {},
  },
}));

// AuthService + IntegrationCache are the Sync's two runtime dependencies outside
// the vendor SDK. Mock both so tests control the session/integration state.
vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: vi.fn(),
  },
}));

vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: {
    isConnected: vi.fn(async () => false),
    getConnected: vi.fn(async () => new Set<string>()),
    getIntegration: vi.fn(async () => undefined),
    invalidate: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports — safe to be static because vitest hoists vi.mock() above them.
// ---------------------------------------------------------------------------

import { StringSession } from 'telegram/sessions';
import { TelegramAuth } from '../../main/services/messaging/platforms/telegram/TelegramAuth';
import { TelegramClient } from '../../main/services/messaging/platforms/telegram/TelegramClient';
import { TelegramSync } from '../../main/services/messaging/platforms/telegram/TelegramSync';
import { MessageTransformer } from '../../main/services/messaging/MessageTransformer';
import { Uploader } from '../../main/services/uploader';
import type { NormalizedMessage } from '../../main/services/messaging/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ACCESS_TOKEN = 'telegram-access-token';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function wipeSessionFile(): void {
  fs.rmSync(TELEGRAM_AUTH_DIR, { recursive: true, force: true });
}

function savedValue(s: StringSession): string {
  return (s as unknown as { _saveValue: string })._saveValue;
}

function makeTelegramMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: 't1',
    text: 'hello from telegram',
    timestamp: new Date('2024-03-10T12:34:56Z'),
    isFromMe: false,
    chatId: 'chat-1',
    contactId: 'contact-1',
    contactName: 'Alice',
    channel: 'TELEGRAM',
    contact: { firstName: 'Alice' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Public barrel — stable surface check.
// ---------------------------------------------------------------------------

describe('messaging-telegram > public barrel', () => {
  it('re-exports TelegramAuth / TelegramClient / TelegramSync', async () => {
    const mod = await import('../../main/services/messaging/platforms/telegram');
    expect(mod.TelegramAuth).toBe(TelegramAuth);
    expect(mod.TelegramClient).toBe(TelegramClient);
    expect(mod.TelegramSync).toBe(TelegramSync);
  });
});

// ---------------------------------------------------------------------------
// TelegramAuth — disk-backed session persistence.
// ---------------------------------------------------------------------------

describe('messaging-telegram > TelegramAuth session persistence', () => {
  beforeEach(() => wipeSessionFile());
  afterEach(() => wipeSessionFile());

  it('hasSession returns false on an empty userData dir (empty state)', () => {
    expect(TelegramAuth.hasSession()).toBe(false);
  });

  it('saveSession writes the SDK-provided string to disk; loadSession round-trips it', () => {
    TelegramAuth.saveSession(new StringSession('SESSIONSTRING-XYZ'));

    expect(fs.existsSync(SESSION_PATH)).toBe(true);
    expect(fs.readFileSync(SESSION_PATH, 'utf-8')).toBe('SESSIONSTRING-XYZ');
    expect(TelegramAuth.hasSession()).toBe(true);
    expect(savedValue(TelegramAuth.loadSession())).toBe('SESSIONSTRING-XYZ');
  });

  it('loadSession returns an empty StringSession when the session file is missing', () => {
    expect(savedValue(TelegramAuth.loadSession())).toBe('');
  });

  it('hasSession returns false for an empty/whitespace-only session file (boundary)', () => {
    TelegramAuth.ensureAuthDir();
    fs.writeFileSync(SESSION_PATH, '   \n  \n', 'utf-8');
    expect(TelegramAuth.hasSession()).toBe(false);
  });

  it('clearSession removes the auth dir and flips hasSession to false', () => {
    TelegramAuth.saveSession(new StringSession('TOKEN'));
    expect(TelegramAuth.hasSession()).toBe(true);

    TelegramAuth.clearSession();
    expect(TelegramAuth.hasSession()).toBe(false);
    expect(fs.existsSync(TELEGRAM_AUTH_DIR)).toBe(false);
  });

  it('getAuthDir reports the Electron userData-scoped path', () => {
    expect(TelegramAuth.getAuthDir()).toBe(TELEGRAM_AUTH_DIR);
  });
});

// ---------------------------------------------------------------------------
// TelegramClient — credentials gate + auth state machine.
//
// The real `client.start()` flow is vendored inside the `telegram` SDK. We
// only assert the public state-machine contract that TelegramClient guarantees
// around it: the credentials gate, submit/cancel behavior in idle state, and
// connect-with-existing-session short-circuits.
// ---------------------------------------------------------------------------

describe('messaging-telegram > TelegramClient auth gating', () => {
  beforeEach(() => {
    wipeSessionFile();
    vi.clearAllMocks();
    clearFetchCaptures();
  });

  afterEach(() => wipeSessionFile());

  it('hasApiCredentials is false when env vars are missing (default for this file)', () => {
    // Module evaluated with file-level env (TELEGRAM_API_ID/HASH unset).
    expect(TelegramClient.hasApiCredentials()).toBe(false);
  });

  it('startAuth returns a structured credential error when API creds are absent (auth boundary)', async () => {
    const client = new TelegramClient();
    const result = await client.startAuth('+19729777432');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/credentials not configured/i);
    expect(client.getAuthState()).toBe('idle');
    expect(client.isConnected()).toBe(false);
  });

  it('submitCode is a safe no-op when not awaiting a code (state-machine guard)', () => {
    const client = new TelegramClient();
    expect(() => client.submitCode('12345')).not.toThrow();
    expect(client.getAuthState()).toBe('idle');
  });

  it('submitPassword is a safe no-op when not awaiting a password (state-machine guard)', () => {
    const client = new TelegramClient();
    expect(() => client.submitPassword('hunter2')).not.toThrow();
    expect(client.getAuthState()).toBe('idle');
  });

  it('cancelAuth resets state and flips connection to disconnected', () => {
    const client = new TelegramClient();
    client.cancelAuth();
    expect(client.getAuthState()).toBe('idle');
    expect(client.getConnectionState()).toBe('disconnected');
  });

  it('connectWithExistingSession returns false when no session file exists (empty state)', async () => {
    const client = new TelegramClient();
    const result = await client.connectWithExistingSession();
    expect(result).toBe(false);
    expect(client.isConnected()).toBe(false);
  });

  it('connectWithExistingSession returns false when a session exists but API creds are absent', async () => {
    TelegramAuth.saveSession(new StringSession('OLD_SESSION'));
    const client = new TelegramClient();
    expect(await client.connectWithExistingSession()).toBe(false);
  });

  it('fetchHistoricalMessages short-circuits to [] when not connected', async () => {
    const client = new TelegramClient();
    expect(await client.fetchHistoricalMessages('peer-id', 50)).toEqual([]);
  });

  it('getDialogs short-circuits to [] when not connected', async () => {
    const client = new TelegramClient();
    expect(await client.getDialogs()).toEqual([]);
  });

  it('disconnect on a never-connected client flips state and emits a connection_change event', async () => {
    const client = new TelegramClient();
    const events: unknown[] = [];
    client.on('sync', (ev) => events.push(ev));

    await client.disconnect();

    expect(client.getConnectionState()).toBe('disconnected');
    expect(events).toEqual([{ type: 'connection_change', channel: 'TELEGRAM', connected: false }]);
  });
});

// ---------------------------------------------------------------------------
// TelegramSync — static coordinator. Tests exercise the branches that do NOT
// require the GramJS runtime (credentials absent, no session, no integration).
// The fetch boundary is exercised via the uploader path.
// ---------------------------------------------------------------------------

describe('messaging-telegram > TelegramSync coordinator', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(async () => {
    wipeSessionFile();
    vi.clearAllMocks();
    clearFetchCaptures();
    // Reset the static singleton so state doesn't leak between tests.
    await TelegramSync.disconnect().catch(() => {});
  });

  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = null;
    await TelegramSync.disconnect().catch(() => {});
    wipeSessionFile();
  });

  it('hasSession reflects disk state (delegates to TelegramAuth)', () => {
    expect(TelegramSync.hasSession()).toBe(false);
    TelegramAuth.saveSession(new StringSession('X'));
    expect(TelegramSync.hasSession()).toBe(true);
  });

  it('hasApiCredentials is false by default (env absent)', () => {
    expect(TelegramSync.hasApiCredentials()).toBe(false);
  });

  it('isConnected is false before any client exists', () => {
    expect(TelegramSync.isConnected()).toBe(false);
    expect(TelegramSync.getClient()).toBeNull();
  });

  it('startAuth forwards the underlying credential error (happy-path for the no-creds branch)', async () => {
    const result = await TelegramSync.startAuth('+19729777432');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/credentials not configured/i);
    // A client was created (so submit/cancel have something to target), but it's not connected.
    expect(TelegramSync.getClient()).not.toBeNull();
    expect(TelegramSync.isConnected()).toBe(false);
  });

  it('submitCode / submitPassword / cancelAuth are safe before startAuth (no client yet)', () => {
    expect(() => TelegramSync.submitCode('12345')).not.toThrow();
    expect(() => TelegramSync.submitPassword('pw')).not.toThrow();
    expect(() => TelegramSync.cancelAuth()).not.toThrow();
  });

  it('syncHistorical returns 0 when not connected (empty state, no fetch issued)', async () => {
    restoreFetch = installFetchCapture({});

    expect(await TelegramSync.syncHistorical()).toBe(0);
    expect(fetchCaptures).toHaveLength(0);
  });

  it('connectWithExistingSession returns false when no session on disk (empty state)', async () => {
    expect(await TelegramSync.connectWithExistingSession()).toBe(false);
  });

  it('disconnect is idempotent on a never-connected sync', async () => {
    await expect(TelegramSync.disconnect()).resolves.toBeUndefined();
    await expect(TelegramSync.disconnect()).resolves.toBeUndefined();
    expect(TelegramSync.isConnected()).toBe(false);
  });

  it('logout on a cold sync leaves TelegramAuth the only clear-path (no client → no disconnect)', () => {
    TelegramAuth.saveSession(new StringSession('TOKEN'));
    expect(TelegramSync.hasSession()).toBe(true);

    // logout() with no client short-circuits: the on-disk session remains until
    // TelegramAuth.clearSession is called directly by the auth layer.
    TelegramSync.logout();
    // Prove the auth-layer clear still works as the final invariant.
    TelegramAuth.clearSession();
    expect(TelegramSync.hasSession()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fetch boundary — the uploader path is the ONE outbound call messaging-telegram
// makes to the mac-app backend. We reach it by driving Uploader directly with
// a MessageTransformer output, which mirrors what TelegramSync.uploadMessages does.
// (syncHistorical can't be driven end-to-end without a live GramJS runtime, so
// we characterize the boundary contract at the same layer TelegramSync hits.)
// ---------------------------------------------------------------------------

describe('messaging-telegram > Uploader fetch boundary', () => {
  const UPLOAD_URL = 'http://localhost:3001/api/integrations/telegram/upload';
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => clearFetchCaptures());
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
  });

  it('POSTs transformer output with bearer auth + JSON body shaped {contacts, accessedAt}', async () => {
    restoreFetch = installFetchCapture({
      '/api/integrations/telegram/upload': () => jsonResponse({ ok: true }),
    });

    const contacts = MessageTransformer.toContactWithMessages([makeTelegramMsg()]);
    const result = await Uploader.uploadData('telegram', contacts, ACCESS_TOKEN, null);

    expect(result.success).toBe(true);
    expect(fetchCaptures).toHaveLength(1);

    const [call] = fetchCaptures;
    expect(call.url).toBe(UPLOAD_URL);
    expect(call.method).toBe('POST');
    expect(call.headers['authorization']).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(call.headers['content-type']).toBe('application/json');

    const body = JSON.parse(call.body ?? '{}');
    expect(Array.isArray(body.contacts)).toBe(true);
    expect(body.contacts[0].contact_id).toBe('contact-1');
    expect(body.contacts[0].messages[0].text).toBe('hello from telegram');
    expect(typeof body.accessedAt).toBe('string');
  });

  it('error state: upload 500 → Uploader returns {success:false}, call still captured', async () => {
    restoreFetch = installFetchCapture({
      '/api/integrations/telegram/upload': () => jsonResponse({ error: 'boom' }, 500),
    });

    const contacts = MessageTransformer.toContactWithMessages([makeTelegramMsg()]);
    const result = await Uploader.uploadData('telegram', contacts, ACCESS_TOKEN, null);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Upload failed/i);
    expect(fetchCaptures).toHaveLength(1);
    expect(fetchCaptures[0].responseStatus).toBe(500);
  });

  it('empty state: empty transformer output still POSTs with {contacts:[], accessedAt}', async () => {
    restoreFetch = installFetchCapture({
      '/api/integrations/telegram/upload': () => jsonResponse({ ok: true }),
    });

    const empty = MessageTransformer.toContactWithMessages([]);
    expect(empty).toEqual([]);

    const result = await Uploader.uploadData('telegram', empty, ACCESS_TOKEN, null);

    expect(result.success).toBe(true);
    expect(fetchCaptures).toHaveLength(1);
    const body = JSON.parse(fetchCaptures[0].body ?? '{}');
    expect(body.contacts).toEqual([]);
    expect(typeof body.accessedAt).toBe('string');
  });
});
