import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubAllElectron } from './electron-stubs';
import {
  installFetchCapture,
  clearFetchCaptures,
  fetchCaptures,
  type MockResponder,
} from './fetch-capture';
import type { IMessageData } from '../../shared/types/ipc';

// Config reads env vars at module-load time — provide sane fakes before any import
// that transitively pulls `main/base/config.ts`.
process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.VITE_BACKEND_API_URL = 'https://backend.test';
process.env.ENCRYPTION_KEY = 'test-encryption-key';

stubAllElectron();

// Mock the reader boundary — it hits a real SQLite DB + macOS native contacts API.
// Mock the IntegrationCache and AuthService boundaries — tests control session + integration state.
vi.mock('../../main/services/iMessageReader', () => {
  return {
    IMessageReader: {
      checkAccess: vi.fn(() => true),
      readMessages: vi.fn(async () => [] as IMessageData[]),
      readMessagesSinceRowId: vi.fn(async () => [] as IMessageData[]),
      toNormalizedMessage: vi.fn(),
      toNormalizedMessages: vi.fn(() => []),
      getMaxRowId: vi.fn(() => 0),
    },
  };
});

vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: vi.fn(),
  },
}));

vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: {
    isConnected: vi.fn(),
    getConnected: vi.fn(),
    getIntegration: vi.fn(),
    invalidate: vi.fn(),
  },
}));

// IMessageWatcher opens a real fs.watch on ~/Library/Messages/chat.db which is
// unreachable in jsdom. Stub with a minimal EventEmitter shape exposing the
// start/stop/isActive contract IMessageSync depends on.
vi.mock('../../main/services/messaging/platforms/imessage/IMessageWatcher', async () => {
  const { EventEmitter } = await import('events');
  class FakeWatcher extends EventEmitter {
    private active = false;
    start(): void {
      this.active = true;
    }
    stop(): void {
      this.active = false;
    }
    isActive(): boolean {
      return this.active;
    }
  }
  return { IMessageWatcher: FakeWatcher };
});

const UPLOAD_PATH = '/api/integrations/imessage/upload';

const uploadResponder: MockResponder = () =>
  new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const uploadCalls = () => fetchCaptures.filter((c) => c.url.includes(UPLOAD_PATH));

function makeMessage(overrides: Partial<IMessageData> = {}): IMessageData {
  return {
    id: 1,
    text: 'hello there',
    date: 700000000000000000,
    is_from_me: false,
    contact_id: '+15555551212',
    contact_name: 'Alice Example',
    contact_firstName: 'Alice',
    contact_lastName: 'Example',
    contact_email: null,
    contact_company: null,
    contact_title: null,
    contact_emailAddresses: [],
    ...overrides,
  };
}

describe('i-message-sync blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(async () => {
    clearFetchCaptures();
    vi.clearAllMocks();

    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { AuthService } = await import('../../main/services/auth');
    const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');

    vi.mocked(IMessageReader.checkAccess).mockReturnValue(true);
    vi.mocked(IMessageReader.readMessages).mockResolvedValue([]);
    vi.mocked(IMessageReader.readMessagesSinceRowId).mockResolvedValue([]);
    vi.mocked(IMessageReader.getMaxRowId).mockReturnValue(0);
    vi.mocked(AuthService.getSession).mockResolvedValue({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      user: { id: 'user-1' },
      expires_at: Date.now() + 60 * 60 * 1000,
    });
    vi.mocked(IntegrationCache.isConnected).mockResolvedValue(true);
    vi.mocked(IntegrationCache.getIntegration).mockResolvedValue({
      name: 'imessage',
      status: 'CONNECTED',
      lastSyncAt: null,
      config: {},
    });

    restoreFetch = installFetchCapture({ [UPLOAD_PATH]: uploadResponder });
  });

  afterEach(() => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  it('happy path: sync reads messages, uploads to backend, and captures the exact boundary call', async () => {
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    const messages = [
      makeMessage({ id: 1, text: 'hi', contact_id: '+15555551212' }),
      makeMessage({ id: 2, text: 'there', contact_id: 'alice@example.com' }),
    ];
    vi.mocked(IMessageReader.readMessages).mockResolvedValue(messages);

    await IMessageSync.sync();

    const calls = uploadCalls();
    expect(calls).toHaveLength(1);

    const call = calls[0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`https://backend.test${UPLOAD_PATH}`);
    expect(call.headers['authorization']).toBe('Bearer test-access-token');
    expect(call.headers['content-type']).toBe('application/json');

    const body = JSON.parse(call.body ?? '{}');
    expect(body).toHaveProperty('contacts');
    expect(body).toHaveProperty('accessedAt');
    expect(typeof body.accessedAt).toBe('string');
    expect(Array.isArray(body.contacts)).toBe(true);
    const ids = body.contacts.map((c: { contact_id: string }) => c.contact_id).sort();
    expect(ids).toEqual(['+15555551212', 'alice@example.com']);
    // Invariant: email-style handles populate `email` and leave `phoneNumber` null;
    // phone handles do the reverse. Asserts the backend contract built in buildIMessagePayload.
    const alice = body.contacts.find(
      (c: { contact_id: string }) => c.contact_id === 'alice@example.com'
    );
    expect(alice.email).toBe('alice@example.com');
    expect(alice.phoneNumber).toBeNull();
  });

  it('empty state: no messages read → no upload fetch is made', async () => {
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IMessageReader.readMessages).mockResolvedValue([]);

    await IMessageSync.sync();

    expect(uploadCalls()).toHaveLength(0);
  });

  it('unauthenticated: no session → no read, no upload', async () => {
    const { AuthService } = await import('../../main/services/auth');
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(AuthService.getSession).mockResolvedValue(null);

    await IMessageSync.sync();

    expect(vi.mocked(IMessageReader.readMessages)).not.toHaveBeenCalled();
    expect(fetchCaptures).toHaveLength(0);
  });

  it('no iMessage access: checkAccess=false → no read, no upload', async () => {
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IMessageReader.checkAccess).mockReturnValue(false);

    await IMessageSync.sync();

    expect(vi.mocked(IMessageReader.readMessages)).not.toHaveBeenCalled();
    expect(fetchCaptures).toHaveLength(0);
  });

  it('integration NOT_CONNECTED → skip sync, no upload', async () => {
    const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IntegrationCache.getIntegration).mockResolvedValue({
      name: 'imessage',
      status: 'NOT_CONNECTED',
    });

    await IMessageSync.sync();

    expect(vi.mocked(IMessageReader.readMessages)).not.toHaveBeenCalled();
    expect(fetchCaptures).toHaveLength(0);
  });

  it('integration missing (undefined) → skip sync, no upload', async () => {
    const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IntegrationCache.getIntegration).mockResolvedValue(undefined);

    await IMessageSync.sync();

    expect(vi.mocked(IMessageReader.readMessages)).not.toHaveBeenCalled();
    expect(fetchCaptures).toHaveLength(0);
  });

  it('integration SYNCING within last hour → skip sync, no upload', async () => {
    const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IntegrationCache.getIntegration).mockResolvedValue({
      name: 'imessage',
      status: 'SYNCING',
      lastSyncAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
    });

    await IMessageSync.sync();

    expect(vi.mocked(IMessageReader.readMessages)).not.toHaveBeenCalled();
    expect(fetchCaptures).toHaveLength(0);
  });

  it('integration SYNCING > 1 hour ago → re-sync proceeds and uploads', async () => {
    const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IntegrationCache.getIntegration).mockResolvedValue({
      name: 'imessage',
      status: 'SYNCING',
      lastSyncAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago → stale
    });
    vi.mocked(IMessageReader.readMessages).mockResolvedValue([
      makeMessage({ id: 10, contact_id: '+15555550000' }),
    ]);

    await IMessageSync.sync();

    expect(uploadCalls()).toHaveLength(1);
  });

  it('incremental sync: uses lastFrontendAccessAt from integration config', async () => {
    const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IntegrationCache.getIntegration).mockResolvedValue({
      name: 'imessage',
      status: 'CONNECTED',
      config: { lastFrontendAccessAt: '2025-01-01T00:00:00.000Z' },
    });
    vi.mocked(IMessageReader.readMessages).mockResolvedValue([makeMessage()]);

    await IMessageSync.sync();

    // Reader invoked with timestamp + isSync=true (incremental)
    expect(IMessageReader.readMessages).toHaveBeenCalledWith('2025-01-01T00:00:00.000Z', true);
  });

  it('full sync: no lastFrontendAccessAt → reader called with undefined + isSync=false', async () => {
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IMessageReader.readMessages).mockResolvedValue([makeMessage()]);

    await IMessageSync.sync();

    expect(IMessageReader.readMessages).toHaveBeenCalledWith(undefined, false);
  });

  it('error state: upload returns non-2xx → sync completes without throwing, failure observed at boundary', async () => {
    if (restoreFetch) restoreFetch();
    restoreFetch = installFetchCapture({
      [UPLOAD_PATH]: () =>
        new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    });
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IMessageReader.readMessages).mockResolvedValue([makeMessage()]);

    // Invariant: upload errors are caught and logged, not propagated — the sync tick
    // must not bring down the scheduler.
    await expect(IMessageSync.sync()).resolves.toBeUndefined();

    const calls = uploadCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].responseStatus).toBe(500);
  });

  it('reader throws → sync catches, no crash, no partial upload', async () => {
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IMessageReader.readMessages).mockRejectedValue(new Error('sqlite locked'));

    await expect(IMessageSync.sync()).resolves.toBeUndefined();
    expect(fetchCaptures).toHaveLength(0);
  });

  it('isRealTimeSyncActive reflects start/stop state transitions', async () => {
    const { IMessageSync } = await import('../../main/services/iMessageSync');

    expect(IMessageSync.isRealTimeSyncActive()).toBe(false);
    // startRealTimeSync requires checkAccess — already true by default
    IMessageSync.startRealTimeSync();
    expect(IMessageSync.isRealTimeSyncActive()).toBe(true);
    // Starting twice is idempotent — still active, no crash
    IMessageSync.startRealTimeSync();
    expect(IMessageSync.isRealTimeSyncActive()).toBe(true);

    IMessageSync.stopRealTimeSync();
    expect(IMessageSync.isRealTimeSyncActive()).toBe(false);
    // Stop again is idempotent
    IMessageSync.stopRealTimeSync();
    expect(IMessageSync.isRealTimeSyncActive()).toBe(false);
  });

  it('startRealTimeSync is a no-op when iMessage access is denied', async () => {
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IMessageReader.checkAccess).mockReturnValue(false);

    IMessageSync.startRealTimeSync();

    expect(IMessageSync.isRealTimeSyncActive()).toBe(false);
    // getMaxRowId must not be called when access check fails
    expect(IMessageReader.getMaxRowId).not.toHaveBeenCalled();
  });

  it('no extraneous outbound calls: sync issues exactly one upload fetch', async () => {
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { IMessageSync } = await import('../../main/services/iMessageSync');
    vi.mocked(IMessageReader.readMessages).mockResolvedValue([makeMessage()]);

    await IMessageSync.sync();

    // IntegrationCache is mocked, so no `/api/integrations` fetch occurs in this
    // isolated run — the upload should be the only outbound call.
    expect(uploadCalls()).toHaveLength(1);
    expect(fetchCaptures).toHaveLength(1);
  });
});
