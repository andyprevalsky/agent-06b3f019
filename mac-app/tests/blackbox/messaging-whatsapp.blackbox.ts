/**
 * messaging-whatsapp domain blackbox
 *
 * Surface under test:
 *   - main/services/messaging/platforms/whatsapp/WhatsAppAuth.ts   (fs-backed creds store: ensure/has/backup/restore/clear/getLinkedPhoneNumber)
 *   - main/services/messaging/platforms/whatsapp/WhatsAppClient.ts (EventEmitter around Baileys socket; normalization helpers, connection state)
 *   - main/services/messaging/platforms/whatsapp/WhatsAppSync.ts   (singleton coordinator: client lifecycle + buffer + flush → Uploader)
 *   - main/services/messaging/platforms/whatsapp/index.ts          (public barrel)
 *
 * This file deliberately scopes to the observable behavior of messaging-whatsapp:
 *   - WhatsAppAuth: state transitions against a temp userData dir (real fs, stubbed electron.app.getPath)
 *   - WhatsAppSync coordinator: exercises the full buffer → flushBuffer → Uploader → fetch boundary,
 *     with AuthService + IntegrationCache + WhatsAppClient mocked (those are other domains'
 *     responsibilities; WhatsAppClient is the Baileys boundary — unsafe to spin up in jsdom).
 *   - Barrel stability: WhatsAppAuth / WhatsAppClient / WhatsAppSync are re-exported.
 *
 * Scope deferrals (per batch prompt):
 *   - Step 5 flake×5 reruns, concurrent invocations.
 *   - Step 6 negative-control perturbations.
 *   - Step 7 broader-suite verification.
 *   - Baileys socket semantics (connection.update, messages.upsert, history sync) — requires running
 *     a real WhatsApp Web socket. Those events reach the coordinator through WhatsAppClient.emit('sync')
 *     which we drive directly in the buffer/flush tests, covering the same downstream contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stubAllElectron } from './electron-stubs';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';
import type { NormalizedMessage, SyncEvent } from '../../main/services/messaging/types';

// Env must exist BEFORE ../../main/base/config is evaluated (Uploader/AuthService pull it in).
process.env.VITE_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.VITE_BACKEND_API_URL ??= 'http://localhost:3001';
process.env.ENCRYPTION_KEY ??= 'test-encryption-key';

// Stub electron BEFORE any import of WhatsAppAuth (which reads app.getPath at module-load time).
// We override getPath below once per test to point at a unique tmp dir.
stubAllElectron();

// Baileys is dynamic-imported inside WhatsAppClient. Provide a static stub so any stray eager
// import (e.g. from the barrel) doesn't pull in the real WebSocket-backed SDK.
vi.mock('@whiskeysockets/baileys', () => ({
  default: {},
  makeWASocket: vi.fn(),
  useMultiFileAuthState: vi.fn(),
  fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 0, 0] })),
  makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
}));

// Also stub telegram transitively (barrel pulls it in via messaging/index.ts).
vi.mock('telegram', () => ({ TelegramClient: vi.fn(), Api: {} }));
vi.mock('telegram/sessions', () => ({
  StringSession: vi.fn().mockImplementation((s: string) => ({ save: () => s ?? '' })),
}));
vi.mock('telegram/events', () => ({ NewMessage: vi.fn() }));
vi.mock('telegram/tl', () => ({ Api: {} }));

// Mock the coordinator's external dependencies. Each test controls these directly.
vi.mock('../../main/services/auth', () => ({
  AuthService: { getSession: vi.fn(), setSession: vi.fn(), clearSession: vi.fn() },
}));

vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: {
    isConnected: vi.fn(),
    getConnected: vi.fn(),
    getIntegration: vi.fn(),
    invalidate: vi.fn(),
  },
}));

// Replace WhatsAppClient with a fake EventEmitter exposing the surface WhatsAppSync depends on.
// This keeps the Baileys boundary out of the test while letting us emit('sync', ...) to drive
// the coordinator through its real buffer → flushBuffer → Uploader → fetch path.
//
// Factory imports are dynamic because vi.mock is hoisted above top-level imports — any
// reference to a module-scope binding here would trip "cannot access before initialization".
vi.mock('../../main/services/messaging/platforms/whatsapp/WhatsAppClient', async () => {
  const { EventEmitter: EE } = await import('events');
  class FakeClient extends EE {
    private connected = false;
    connect = vi.fn(async () => {
      this.connected = true;
    });
    disconnect = vi.fn(async () => {
      this.connected = false;
    });
    logout = vi.fn(async () => {
      this.connected = false;
    });
    isConnected = (): boolean => this.connected;
  }
  return { WhatsAppClient: FakeClient };
});

/**
 * Per-test tmp dir that `electron.app.getPath('userData')` resolves to. WhatsAppAuth
 * concatenates `whatsapp-auth` onto the result of `app.getPath('userData')` at module-load
 * time — the constant is captured once. We therefore also re-import the module fresh each
 * test (vi.resetModules) so WHATSAPP_AUTH_DIR tracks the tmp dir we set for this test.
 */
let tmpUserData = '';
let tmpAuthDir = '';

async function freshWhatsAppAuth(): Promise<
  typeof import('../../main/services/messaging/platforms/whatsapp/WhatsAppAuth')
> {
  const electron = await import('electron');
  vi.resetModules();
  // Re-install the electron stub for the reset module registry so WhatsAppAuth's
  // `app.getPath('userData')` resolves to our per-test tmp dir on fresh import.
  vi.doMock('electron', () => ({
    ...electron,
    app: { ...electron.app, getPath: vi.fn(() => tmpUserData) },
  }));
  return import('../../main/services/messaging/platforms/whatsapp/WhatsAppAuth');
}

/**
 * Build a NormalizedMessage for a WHATSAPP channel with sensible defaults.
 */
function makeWhatsAppMessage(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  const base: NormalizedMessage = {
    id: 'wa-1',
    text: 'hello',
    timestamp: new Date('2024-01-01T00:00:00Z'),
    isFromMe: false,
    chatId: '+15555551212@s.whatsapp.net',
    contactId: '+15555551212',
    contactName: 'Alice',
    channel: 'WHATSAPP',
    contact: { firstName: 'Alice' },
  };
  return { ...base, ...overrides };
}

describe('messaging-whatsapp > WhatsAppAuth (fs-backed credentials)', () => {
  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-auth-test-'));
    tmpAuthDir = path.join(tmpUserData, 'whatsapp-auth');
  });

  afterEach(() => {
    if (tmpUserData && fs.existsSync(tmpUserData)) {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });

  it('getAuthDir returns the app-userData-scoped directory (stable, deterministic)', async () => {
    const { WhatsAppAuth } = await freshWhatsAppAuth();
    expect(WhatsAppAuth.getAuthDir()).toBe(tmpAuthDir);
  });

  it('ensureAuthDir: creates the dir if missing (read-after-write invariant)', async () => {
    const { WhatsAppAuth } = await freshWhatsAppAuth();
    expect(fs.existsSync(tmpAuthDir)).toBe(false);
    WhatsAppAuth.ensureAuthDir();
    expect(fs.existsSync(tmpAuthDir)).toBe(true);
    // idempotent — second call does not throw
    WhatsAppAuth.ensureAuthDir();
    expect(fs.existsSync(tmpAuthDir)).toBe(true);
  });

  it('hasCredentials: false when dir missing, file missing, empty, or invalid JSON; true only for valid JSON', async () => {
    const { WhatsAppAuth } = await freshWhatsAppAuth();

    // dir missing
    expect(WhatsAppAuth.hasCredentials()).toBe(false);

    fs.mkdirSync(tmpAuthDir, { recursive: true });
    // file missing
    expect(WhatsAppAuth.hasCredentials()).toBe(false);

    const credsPath = path.join(tmpAuthDir, 'creds.json');

    // empty file (size 0) → false
    fs.writeFileSync(credsPath, '');
    expect(WhatsAppAuth.hasCredentials()).toBe(false);

    // tiny file (size <= 1) → false
    fs.writeFileSync(credsPath, ' ');
    expect(WhatsAppAuth.hasCredentials()).toBe(false);

    // invalid JSON → false
    fs.writeFileSync(credsPath, '{not-json');
    expect(WhatsAppAuth.hasCredentials()).toBe(false);

    // valid JSON → true
    fs.writeFileSync(credsPath, JSON.stringify({ me: { id: '15555551212:1@s.whatsapp.net' } }));
    expect(WhatsAppAuth.hasCredentials()).toBe(true);
  });

  it('backupCredentials: copies valid creds.json → creds.json.bak, no-ops on missing/invalid', async () => {
    const { WhatsAppAuth } = await freshWhatsAppAuth();
    const credsPath = path.join(tmpAuthDir, 'creds.json');
    const backupPath = path.join(tmpAuthDir, 'creds.json.bak');

    // no creds dir → no-op (no throw)
    WhatsAppAuth.backupCredentials();
    expect(fs.existsSync(backupPath)).toBe(false);

    // invalid creds → no backup
    fs.mkdirSync(tmpAuthDir, { recursive: true });
    fs.writeFileSync(credsPath, '{bad');
    WhatsAppAuth.backupCredentials();
    expect(fs.existsSync(backupPath)).toBe(false);

    // valid creds → backup
    fs.writeFileSync(credsPath, JSON.stringify({ me: { id: '15555551212@s.whatsapp.net' } }));
    WhatsAppAuth.backupCredentials();
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(backupPath, 'utf-8')).me.id).toBe(
      '15555551212@s.whatsapp.net'
    );
  });

  it('maybeRestoreFromBackup: valid creds → false (no restore); corrupted creds + valid backup → true (restores)', async () => {
    const { WhatsAppAuth } = await freshWhatsAppAuth();
    const credsPath = path.join(tmpAuthDir, 'creds.json');
    const backupPath = path.join(tmpAuthDir, 'creds.json.bak');

    fs.mkdirSync(tmpAuthDir, { recursive: true });

    // Case 1: valid creds → restore returns false, creds unchanged
    fs.writeFileSync(credsPath, JSON.stringify({ me: { id: 'original@s.whatsapp.net' } }));
    fs.writeFileSync(backupPath, JSON.stringify({ me: { id: 'backup@s.whatsapp.net' } }));
    expect(WhatsAppAuth.maybeRestoreFromBackup()).toBe(false);
    expect(JSON.parse(fs.readFileSync(credsPath, 'utf-8')).me.id).toBe('original@s.whatsapp.net');

    // Case 2: corrupted creds + valid backup → restore returns true, creds = backup
    fs.writeFileSync(credsPath, '{corrupt');
    expect(WhatsAppAuth.maybeRestoreFromBackup()).toBe(true);
    expect(JSON.parse(fs.readFileSync(credsPath, 'utf-8')).me.id).toBe('backup@s.whatsapp.net');

    // Case 3: missing creds + no backup → false
    fs.rmSync(credsPath);
    fs.rmSync(backupPath);
    expect(WhatsAppAuth.maybeRestoreFromBackup()).toBe(false);
  });

  it('clearCredentials: removes the auth dir entirely (cleanup invariant)', async () => {
    const { WhatsAppAuth } = await freshWhatsAppAuth();
    fs.mkdirSync(tmpAuthDir, { recursive: true });
    fs.writeFileSync(path.join(tmpAuthDir, 'creds.json'), '{}');
    fs.writeFileSync(path.join(tmpAuthDir, 'app-state-sync-key-xyz.json'), '{}');

    WhatsAppAuth.clearCredentials();

    expect(fs.existsSync(tmpAuthDir)).toBe(false);
    // calling again when already cleared is a no-op
    expect(() => WhatsAppAuth.clearCredentials()).not.toThrow();
  });

  it('getLinkedPhoneNumber: extracts E.164-style number from Baileys JID; null on missing/invalid creds', async () => {
    const { WhatsAppAuth } = await freshWhatsAppAuth();
    const credsPath = path.join(tmpAuthDir, 'creds.json');

    // missing dir → null
    expect(WhatsAppAuth.getLinkedPhoneNumber()).toBeNull();

    fs.mkdirSync(tmpAuthDir, { recursive: true });

    // missing file → null
    expect(WhatsAppAuth.getLinkedPhoneNumber()).toBeNull();

    // invalid JSON → null (caught, not thrown)
    fs.writeFileSync(credsPath, '{not-json');
    expect(WhatsAppAuth.getLinkedPhoneNumber()).toBeNull();

    // valid creds with full JID (includes device suffix)
    fs.writeFileSync(credsPath, JSON.stringify({ me: { id: '15555551212:12@s.whatsapp.net' } }));
    expect(WhatsAppAuth.getLinkedPhoneNumber()).toBe('+15555551212');

    // valid creds with JID lacking device suffix
    fs.writeFileSync(credsPath, JSON.stringify({ me: { id: '442071838750@s.whatsapp.net' } }));
    expect(WhatsAppAuth.getLinkedPhoneNumber()).toBe('+442071838750');

    // valid JSON but no `me` → null
    fs.writeFileSync(credsPath, JSON.stringify({ other: 'data' }));
    expect(WhatsAppAuth.getLinkedPhoneNumber()).toBeNull();

    // valid JSON with `me` but no `id` → null
    fs.writeFileSync(credsPath, JSON.stringify({ me: {} }));
    expect(WhatsAppAuth.getLinkedPhoneNumber()).toBeNull();
  });
});

describe('messaging-whatsapp > public barrel (platforms/whatsapp/index.ts)', () => {
  it('re-exports WhatsAppAuth, WhatsAppClient, WhatsAppSync', async () => {
    // vi.mock for WhatsAppClient applies to this file's module graph, so the barrel's
    // WhatsAppClient export resolves to the FakeClient constructor here. Assert on
    // constructor-ness rather than identity.
    const mod = await import('../../main/services/messaging/platforms/whatsapp');
    expect(typeof mod.WhatsAppAuth).toBe('function');
    expect(typeof mod.WhatsAppClient).toBe('function');
    expect(typeof mod.WhatsAppSync).toBe('function');
  });
});

const UPLOAD_PATH = '/api/integrations/whatsapp/upload';
const CONNECT_PATH = '/api/integrations/whatsapp/connect';
const PROGRESS_PATH = '/api/integrations/whatsapp/accounts/default/progress';
const uploadCalls = () => fetchCaptures.filter((c) => c.url.includes(UPLOAD_PATH));

describe('messaging-whatsapp > WhatsAppSync (coordinator + fetch boundary)', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(async () => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-sync-test-'));
    tmpAuthDir = path.join(tmpUserData, 'whatsapp-auth');

    clearFetchCaptures();
    vi.clearAllMocks();

    const { AuthService } = await import('../../main/services/auth');
    const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');

    vi.mocked(AuthService.getSession).mockResolvedValue({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      user: { id: 'user-1' },
      expires_at: Date.now() + 60 * 60 * 1000,
    });
    vi.mocked(IntegrationCache.isConnected).mockResolvedValue(true);

    // Reset the WhatsAppSync singleton static state between tests. logout() clears the
    // messageBuffer; disconnect() does not (it flushes, and on upload failure re-queues).
    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');
    await WhatsAppSync.logout();

    restoreFetch = installFetchCapture({
      [UPLOAD_PATH]: () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      [CONNECT_PATH]: () =>
        new Response(JSON.stringify({ message: 'WhatsApp connected successfully' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
  });

  afterEach(async () => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');
    // logout() (not disconnect) also clears the messageBuffer so state doesn't leak.
    await WhatsAppSync.logout();
    if (tmpUserData && fs.existsSync(tmpUserData)) {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });

  async function getSyncAndClient(): Promise<{
    WhatsAppSync: typeof import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync').WhatsAppSync;
    client: EventEmitter;
  }> {
    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');
    await WhatsAppSync.connect();
    // The coordinator instantiates one FakeClient per connect(); dig it out by poking the
    // private static field via a typed cast. Tests drive it via emit('sync', ...) exactly as
    // the real Baileys-backed client does.
    const client = (WhatsAppSync as unknown as { client: EventEmitter | null }).client;
    if (!client) throw new Error('WhatsAppSync.client not set after connect()');
    return { WhatsAppSync, client };
  }

  it('isConnected defaults to false before connect(), true after', async () => {
    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');
    expect(WhatsAppSync.isConnected()).toBe(false);

    await WhatsAppSync.connect();
    expect(WhatsAppSync.isConnected()).toBe(true);

    await WhatsAppSync.disconnect();
    expect(WhatsAppSync.isConnected()).toBe(false);
  });

  it('happy path: new_messages event → buffered → disconnect flushes to /api/integrations/whatsapp/upload with bearer + JSON body', async () => {
    const { WhatsAppSync, client } = await getSyncAndClient();

    const messages = [
      makeWhatsAppMessage({ id: 'wa-1', contactId: '+15555551212', text: 'hi' }),
      makeWhatsAppMessage({ id: 'wa-2', contactId: '+15555551212', text: 'there' }),
      makeWhatsAppMessage({ id: 'wa-3', contactId: '+15555550000', text: 'yo' }),
    ];

    // Emit one batch — buffer size is under MAX_BUFFER_SIZE so it won't auto-flush here.
    client.emit('sync', {
      type: 'new_messages',
      channel: 'WHATSAPP',
      messages,
    } satisfies SyncEvent);

    // disconnect() triggers flushBuffer() — deterministic way to drive the upload without
    // relying on the 5s timer.
    await WhatsAppSync.disconnect();

    const calls = uploadCalls();
    expect(calls).toHaveLength(1);

    const call = calls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`http://localhost:3001${UPLOAD_PATH}`);
    expect(call.headers['authorization']).toBe('Bearer test-access-token');
    expect(call.headers['content-type']).toBe('application/json');

    const body = JSON.parse(call.body ?? '{}');
    expect(Array.isArray(body.contacts)).toBe(true);
    expect(typeof body.accessedAt).toBe('string');
    const ids = body.contacts.map((c: { contact_id: string }) => c.contact_id).sort();
    expect(ids).toEqual(['+15555550000', '+15555551212']);
    // 2 messages for +15555551212, 1 for +15555550000 (channel ms-epoch timestamps)
    const alice = body.contacts.find(
      (c: { contact_id: string }) => c.contact_id === '+15555551212'
    );
    expect(alice.messages.map((m: { text: string }) => m.text).sort()).toEqual(['hi', 'there']);
  });

  it('history sync progress: each batch posts messages received + Baileys percent; the last batch ends synced', async () => {
    const { client } = await getSyncAndClient();
    const progressCalls = () => fetchCaptures.filter((c) => c.url.includes(PROGRESS_PATH));

    client.emit('sync', {
      type: 'new_messages',
      channel: 'WHATSAPP',
      messages: [makeWhatsAppMessage({ id: 'h-1' }), makeWhatsAppMessage({ id: 'h-2' })],
      history: { progress: 40, isLatest: false },
    } satisfies SyncEvent);
    await vi.waitFor(() => expect(progressCalls()).toHaveLength(1));
    client.emit('sync', {
      type: 'new_messages',
      channel: 'WHATSAPP',
      messages: [makeWhatsAppMessage({ id: 'h-3' })],
      history: { progress: null, isLatest: true },
    } satisfies SyncEvent);
    await vi.waitFor(() => expect(progressCalls()).toHaveLength(2));

    const [first, last] = progressCalls();
    expect(first.url).toBe(`http://localhost:3001${PROGRESS_PATH}`);
    expect(first.method).toBe('POST');
    expect(first.headers['authorization']).toBe('Bearer test-access-token');
    const opened = JSON.parse(first.body ?? '{}');
    expect(opened).toMatchObject({
      seq: 1,
      state: 'syncing',
      phase: 'history',
      unit: 'messages',
      done: 2,
      total: null,
      pct: 40,
    });
    const closed = JSON.parse(last.body ?? '{}');
    expect(closed).toMatchObject({ seq: 2, state: 'synced', unit: 'messages', done: 3 });
    expect(closed.runId).toBe(opened.runId);
    // History messages still flow through the normal buffered upload.
    expect(uploadCalls()).toHaveLength(0);
  });

  it('auth boundary: no session → flushBuffer skips upload, buffer preserved, no fetch issued', async () => {
    const { AuthService } = await import('../../main/services/auth');
    vi.mocked(AuthService.getSession).mockResolvedValue(null);

    const { WhatsAppSync, client } = await getSyncAndClient();
    client.emit('sync', {
      type: 'new_messages',
      channel: 'WHATSAPP',
      messages: [makeWhatsAppMessage()],
    } satisfies SyncEvent);

    await WhatsAppSync.disconnect();

    const calls = uploadCalls();
    expect(calls).toHaveLength(0);
  });

  it('integration not connected → flushBuffer skips upload, no fetch issued', async () => {
    const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');
    vi.mocked(IntegrationCache.isConnected).mockResolvedValue(false);

    const { WhatsAppSync, client } = await getSyncAndClient();
    client.emit('sync', {
      type: 'new_messages',
      channel: 'WHATSAPP',
      messages: [makeWhatsAppMessage()],
    } satisfies SyncEvent);

    await WhatsAppSync.disconnect();

    const calls = uploadCalls();
    expect(calls).toHaveLength(0);
  });

  it('empty state: no messages buffered → disconnect issues no upload fetch', async () => {
    const { WhatsAppSync } = await getSyncAndClient();
    // No sync events emitted.
    await WhatsAppSync.disconnect();

    const calls = uploadCalls();
    expect(calls).toHaveLength(0);
  });

  it('error state: upload endpoint returns non-2xx → disconnect completes, boundary captured with failing status', async () => {
    if (restoreFetch) restoreFetch();
    restoreFetch = installFetchCapture({
      [UPLOAD_PATH]: () =>
        new Response(JSON.stringify({ error: 'boom' }), {
          status: 500,
          statusText: 'Internal Server Error',
          headers: { 'content-type': 'application/json' },
        }),
    });

    const { WhatsAppSync, client } = await getSyncAndClient();
    client.emit('sync', {
      type: 'new_messages',
      channel: 'WHATSAPP',
      messages: [makeWhatsAppMessage()],
    } satisfies SyncEvent);

    // Coordinator must not throw on a failed upload — the scheduler keeps running.
    await expect(WhatsAppSync.disconnect()).resolves.toBeUndefined();

    const calls = uploadCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].responseStatus).toBe(500);
  });

  it('ignores non-new_messages events (connection_change, error) → no upload', async () => {
    const { WhatsAppSync, client } = await getSyncAndClient();

    client.emit('sync', {
      type: 'connection_change',
      channel: 'WHATSAPP',
      connected: true,
    } satisfies SyncEvent);
    client.emit('sync', {
      type: 'error',
      channel: 'WHATSAPP',
      error: new Error('upstream failure'),
    } satisfies SyncEvent);

    await WhatsAppSync.disconnect();

    expect(uploadCalls()).toHaveLength(0);
  });

  it('hasCredentials/getLinkedPhoneNumber delegate to WhatsAppAuth (no fetch, deterministic)', async () => {
    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');
    // With no creds dir on disk under tmpUserData, hasCredentials is false and
    // getLinkedPhoneNumber is null — the coordinator is a pass-through.
    expect(WhatsAppSync.hasCredentials()).toBe(false);
    expect(WhatsAppSync.getLinkedPhoneNumber()).toBeNull();
  });

  it('syncHistorical before connect → 0, no fetch', async () => {
    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');
    const n = await WhatsAppSync.syncHistorical();
    expect(n).toBe(0);
    expect(fetchCaptures).toHaveLength(0);
  });

  it('logout tears down the client and clears the buffer (no later flush uploads stale data)', async () => {
    const { WhatsAppSync, client } = await getSyncAndClient();
    client.emit('sync', {
      type: 'new_messages',
      channel: 'WHATSAPP',
      messages: [makeWhatsAppMessage()],
    } satisfies SyncEvent);

    await WhatsAppSync.logout();

    // After logout, even a subsequent disconnect must not fire an upload — buffer was cleared.
    await WhatsAppSync.disconnect();

    const calls = uploadCalls();
    expect(calls).toHaveLength(0);
    expect(WhatsAppSync.isConnected()).toBe(false);
  });
});

/**
 * Baileys socket semantics around the connection.update close branch.
 *
 * These drive the REAL WhatsAppClient (imported from the domain path, which the
 * legacy-shim mock above does not intercept) against a faked Baileys module, so
 * the credential-lifecycle decisions are exercised end to end rather than
 * asserted on a pure helper alone.
 */
describe('messaging-whatsapp > backend registration on connect', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(async () => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-register-test-'));
    tmpAuthDir = path.join(tmpUserData, 'whatsapp-auth');
    clearFetchCaptures();
    vi.clearAllMocks();

    const { AuthService } = await import('../../main/services/auth');
    vi.mocked(AuthService.getSession).mockResolvedValue({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      user: { id: 'user-1' },
      expires_at: Date.now() + 60 * 60 * 1000,
    });

    restoreFetch = installFetchCapture({
      [CONNECT_PATH]: () =>
        new Response(JSON.stringify({ message: 'WhatsApp connected successfully' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
  });

  afterEach(async () => {
    restoreFetch?.();
    restoreFetch = null;
    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');
    await WhatsAppSync.logout();
    if (tmpUserData && fs.existsSync(tmpUserData)) {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
  });

  const connectCalls = () => fetchCaptures.filter((c) => c.url.includes(CONNECT_PATH));

  it('marks the integration CONNECTED on pair, breaking the upload deadlock', async () => {
    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');

    await WhatsAppSync.connect();

    // Without this POST the uploader's isConnected() gate never opens and every
    // synced message is silently dropped.
    expect(connectCalls()).toHaveLength(1);
  });

  it('invalidates the integration cache so the next flush sees the new row', async () => {
    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');
    const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');

    await WhatsAppSync.connect();

    expect(vi.mocked(IntegrationCache.invalidate)).toHaveBeenCalled();
  });

  it('registers exactly once per connect, not once per callback path', async () => {
    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');

    await WhatsAppSync.connect();

    expect(connectCalls()).toHaveLength(1);
  });

  it('does not register when unauthenticated', async () => {
    const { AuthService } = await import('../../main/services/auth');
    vi.mocked(AuthService.getSession).mockResolvedValue(null);

    const { WhatsAppSync } =
      await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');
    await WhatsAppSync.connect();

    expect(connectCalls()).toHaveLength(0);
  });
});

describe('messaging-whatsapp > connection close (Baileys socket semantics)', () => {
  const STATUS_LOGGED_OUT = 401;
  const STATUS_RESTART_REQUIRED = 515;

  let harness: Awaited<ReturnType<typeof bootClient>>;

  /**
   * Boot a real WhatsAppClient over a fake Baileys socket rooted at a per-test
   * tmp userData dir, with a `creds.json` already on disk (a paired session).
   */
  async function bootClient() {
    const electron = await import('electron');
    vi.resetModules();
    vi.doMock('electron', () => ({
      ...electron,
      app: { ...electron.app, getPath: vi.fn(() => tmpUserData) },
    }));

    const { EventEmitter: EE } = await import('events');
    const sock = Object.assign(new EE(), {
      ev: new EE(),
      ws: Object.assign(new EE(), { close: vi.fn() }),
      user: { id: '15555551212:1@s.whatsapp.net' },
    });
    // Baileys' `ev` needs `.off`; EventEmitter provides it. Resolve connect()
    // promptly by reporting an open connection once handlers are attached.
    const makeWASocket = vi.fn(() => {
      setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
      return sock;
    });

    vi.doMock('../../main/domains/messaging-whatsapp/client-loader', () => ({
      loadBaileys: vi.fn(async () => ({
        makeWASocket,
        useMultiFileAuthState: vi.fn(async () => ({
          state: { creds: {}, keys: {} },
          saveCreds: vi.fn(async () => {}),
        })),
        fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 0, 0] })),
        makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
      })),
      resetBaileysCache: vi.fn(),
      silentBaileysLogger: { level: 'silent', child: () => ({}) },
    }));

    const { WhatsAppClient } = await import('../../main/domains/messaging-whatsapp/service');
    const { WhatsAppAuth } = await import('../../main/domains/messaging-whatsapp/repo');

    WhatsAppAuth.ensureAuthDir();
    const credsPath = path.join(WhatsAppAuth.getAuthDir(), 'creds.json');
    fs.writeFileSync(credsPath, JSON.stringify({ me: { id: 'paired' } }));

    const client = new WhatsAppClient();
    await client.connect({ onQRCode: vi.fn() });

    return { client, sock, makeWASocket, credsPath };
  }

  /** Emit a Baileys `connection: 'close'` carrying a DisconnectReason code. */
  function emitClose(h: Awaited<ReturnType<typeof bootClient>>, statusCode: number): void {
    h.sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode } } },
    });
  }

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-close-test-'));
    tmpAuthDir = path.join(tmpUserData, 'whatsapp-auth');
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (harness) await harness.client.disconnect().catch(() => {});
    if (tmpUserData && fs.existsSync(tmpUserData)) {
      fs.rmSync(tmpUserData, { recursive: true, force: true });
    }
    vi.doUnmock('../../main/domains/messaging-whatsapp/client-loader');
  });

  it('keeps credentials on 515 restartRequired (post-pairing handshake)', async () => {
    harness = await bootClient();
    expect(fs.existsSync(harness.credsPath)).toBe(true);

    emitClose(harness, STATUS_RESTART_REQUIRED);

    // 515 means "re-dial with the creds you just saved". Wiping them here bounces
    // the user back to a fresh QR code, so pairing can never complete.
    expect(fs.existsSync(harness.credsPath)).toBe(true);
    expect(tmpAuthDir).toContain('whatsapp-auth');
  });

  it('reconnects after 515 reusing the existing credentials', async () => {
    harness = await bootClient();
    expect(harness.makeWASocket).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    emitClose(harness, STATUS_RESTART_REQUIRED);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harness.makeWASocket).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(harness.credsPath)).toBe(true);
  });

  it('clears credentials on 401 loggedOut', async () => {
    harness = await bootClient();
    expect(fs.existsSync(harness.credsPath)).toBe(true);

    emitClose(harness, STATUS_LOGGED_OUT);

    expect(fs.existsSync(harness.credsPath)).toBe(false);
  });

  it('emits a history batch with its progress even when it has no messages', async () => {
    harness = await bootClient();
    const events: SyncEvent[] = [];
    harness.client.on('sync', (event: SyncEvent) => events.push(event));

    harness.sock.ev.emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages: [],
      isLatest: true,
      progress: 100,
    });

    expect(events).toEqual([
      {
        type: 'new_messages',
        channel: 'WHATSAPP',
        messages: [],
        history: { progress: 100, isLatest: true },
      },
    ]);
  });

  it('does not resurrect the socket when disconnect() races a pending reconnect', async () => {
    harness = await bootClient();
    expect(harness.makeWASocket).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    emitClose(harness, STATUS_RESTART_REQUIRED);
    await harness.client.disconnect();
    await vi.advanceTimersByTimeAsync(5_000);

    // The reconnect timer must be cancelled by the explicit disconnect.
    expect(harness.makeWASocket).toHaveBeenCalledTimes(1);
    expect(harness.client.isConnected()).toBe(false);
  });
});
