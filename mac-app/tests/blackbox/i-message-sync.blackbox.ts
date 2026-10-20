/**
 * Blackbox tests for the i-message-sync domain (plan row I1).
 *
 *   fixture chat.db (fake better-sqlite3) ─► IMessageReader (real)
 *        ─► IMessageSync (real) ─► fetch boundary: batch upload + progress POST
 *
 * Observable contract:
 *   - total = COUNT of chat.db message rows, counted before the first upload
 *   - every uploaded batch posts progress { runId, seq, done, total } for this
 *     Mac's account; the last batch's write is the terminal `synced`
 *   - a resumed sync continues from its cursor under the same runId and done
 *     never moves backwards; the next run starts after it with a new runId
 *   - accountId = this Mac's device id (deviceIdentity); two Macs, two accounts
 *   - `connect` addresses the account until it exists, then `sync`; a 410 stops
 *     the run and nothing re-creates the account until the user connects again
 *   - a 202 { retryAfterMs } holds further non-terminal progress writes
 * Stubbed boundaries: better-sqlite3 (fixture), ioreg/scutil (child_process),
 * AuthService, IntegrationCache, the chat.db file watcher, backend HTTP.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearFetchCaptures, fetchCaptures, installFetchCapture } from './fetch-capture';

process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.VITE_BACKEND_API_URL = 'https://backend.test';
process.env.ENCRYPTION_KEY = 'test-encryption-key';

interface FixtureRow {
  id: number;
  text: string | null;
  date: number;
  is_from_me: number;
  associated_message_text: string | null;
  attributedBody: Buffer | null;
  handle_id: string | null;
  chat_identifier: string | null;
  contact_name: string | null;
}

const env = vi.hoisted(() => ({
  home: '',
  userData: '',
  hardwareUuid: 'AAAAAAAA-0000-4000-8000-00000000000A' as string | null,
  computerName: "Andy's MacBook Pro",
  events: [] as string[],
  rows: [] as FixtureRow[],
  throwOnOpen: null as Error | null,
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'home' ? env.home : env.userData)),
    getAppPath: vi.fn(() => env.home),
    getName: vi.fn(() => 'rose-desktop-test'),
    getVersion: vi.fn(() => '0.0.0-test'),
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => true),
    isPackaged: false,
    name: '',
  },
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(s)),
    decryptString: vi.fn((b: Buffer) => b.toString()),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFileSync = (command: string) => {
    if (command === 'ioreg') {
      if (env.hardwareUuid === null) throw new Error('ioreg unavailable');
      return `+-o Mac  <class IOPlatformExpertDevice>\n  "IOPlatformUUID" = "${env.hardwareUuid}"\n`;
    }
    if (command === 'scutil') return `${env.computerName}\n`;
    throw new Error(`unexpected command ${command}`);
  };
  const mocked = { ...actual, execFileSync };
  return { ...mocked, default: mocked };
});

/** Fixture chat.db: answers exactly the statements the reader issues. */
vi.mock('better-sqlite3', () => {
  const inRange = (row: FixtureRow, after: number, upTo: number) =>
    row.id > after && row.id <= upTo;
  const content = (row: FixtureRow) =>
    (row.text !== null || row.attributedBody !== null) &&
    (row.chat_identifier === null || !row.chat_identifier.startsWith('chat'));
  const statement = (sql: string) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('PRAGMA table_info')) {
      return { all: () => [{ name: 'associated_message_text' }, { name: 'attributedBody' }] };
    }
    if (s.startsWith('SELECT COUNT(*) AS total FROM message')) {
      return {
        get: (after: number, upTo: number) => {
          env.events.push('sql:count');
          return { total: env.rows.filter((r) => inRange(r, after, upTo)).length };
        },
      };
    }
    if (s.startsWith('SELECT MAX(ROWID)')) {
      return {
        get: () => ({ maxId: env.rows.length ? Math.max(...env.rows.map((r) => r.id)) : null }),
      };
    }
    if (s.includes('AS scanned')) {
      return {
        get: (after: number, upTo: number, limit: number) => {
          const ids = env.rows.filter((r) => inRange(r, after, upTo)).map((r) => r.id);
          const window = ids.sort((a, b) => a - b).slice(0, limit);
          return {
            scanned: window.length,
            lastRowId: window.length ? window[window.length - 1] : null,
          };
        },
      };
    }
    if (s.includes('m.ROWID > ? AND m.ROWID <= ?')) {
      return {
        all: (after: number, last: number) =>
          env.rows.filter((r) => inRange(r, after, last) && content(r)),
      };
    }
    if (s.includes('m.is_from_me = 1')) {
      return {
        all: (...handles: string[]) =>
          handles
            .filter((h) => env.rows.some((r) => r.is_from_me === 1 && r.handle_id === h))
            .map((handle_id) => ({ handle_id })),
      };
    }
    if (s.includes('m.ROWID > ? AND')) {
      return { all: (since: number) => env.rows.filter((r) => r.id > since && content(r)) };
    }
    throw new Error(`fixture chat.db: unexpected SQL ${s.slice(0, 120)}`);
  };
  return {
    default: class FixtureDatabase {
      constructor() {
        if (env.throwOnOpen !== null) throw env.throwOnOpen;
      }
      prepare(sql: string) {
        return statement(sql);
      }
      close() {}
    },
  };
});

vi.mock('node-mac-contacts', () => ({
  getAllContacts: () => [],
  getAuthStatus: () => 'Authorized',
}));
vi.mock('bplist-parser', () => ({ parseBuffer: () => [] }));

vi.mock('../../main/services/auth', () => ({ AuthService: { getSession: vi.fn() } }));

vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: {
    getAccounts: vi.fn(),
    getIntegration: vi.fn(),
    isConnected: vi.fn(),
    getConnected: vi.fn(),
    invalidate: vi.fn(),
  },
}));

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

// ── helpers ───────────────────────────────────────────────────────────────

const UPLOAD_PATH = '/api/integrations/imessage/upload';
const SESSION = {
  access_token: 'test-access-token',
  refresh_token: 'test-refresh-token',
  user: { id: 'user-1' },
  expires_at: Date.now() + 60 * 60 * 1000,
};
const deviceIdOf = (uuid: string) =>
  createHash('sha256').update(`rose-mac-device-v1\0${uuid}`).digest('hex').slice(0, 32);
const MAC_A = deviceIdOf('AAAAAAAA-0000-4000-8000-00000000000A');

/**
 * `count` chat.db rows: 1-in-10 group chat, 1-in-10 attachment-only (no text),
 * replies to +15555550001 and alice@example.com, and a never-replied sender.
 */
function chatDb(count: number, from = 1): FixtureRow[] {
  const rows: FixtureRow[] = [];
  for (let id = from; id < from + count; id++) {
    const kind = id % 10;
    const handle = ['+15555550001', 'alice@example.com', '+15555550002'][id % 3];
    rows.push({
      id,
      text: kind === 1 ? null : `message ${id}`,
      date: 700_000_000_000_000_000 + id,
      is_from_me: kind === 2 || kind === 5 ? (handle === '+15555550002' ? 0 : 1) : 0,
      associated_message_text: null,
      attributedBody: null,
      handle_id: handle,
      chat_identifier: kind === 0 ? 'chat884422' : handle,
      contact_name: null,
    });
  }
  return rows;
}

type Body = Record<string, unknown>;
let uploadStatus: (call: number) => number = () => 200;
let progressReply: (call: number) => { status: number; body: Body } = () => ({
  status: 200,
  body: { applied: true },
});

function installBackend(): () => void {
  let uploads = 0;
  let progress = 0;
  return installFetchCapture({
    [UPLOAD_PATH]: () => {
      env.events.push('upload');
      const status = uploadStatus(++uploads);
      const body = status === 410 ? { error: 'ACCOUNT_REMOVED' } : { stored: { messages: 1 } };
      return new Response(JSON.stringify(body), { status });
    },
    '/progress': () => {
      env.events.push('progress');
      const reply = progressReply(++progress);
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    },
  });
}

const uploads = () =>
  fetchCaptures
    .filter((c) => c.url.endsWith(UPLOAD_PATH))
    .map((c) => JSON.parse(c.body ?? '{}') as Body & { contacts: Array<{ messages: Body[] }> });
const progressCalls = () => fetchCaptures.filter((c) => c.url.includes('/progress'));
const progressBodies = () => progressCalls().map((c) => JSON.parse(c.body ?? '{}') as Body);
const uploadedIds = (body: { contacts: Array<{ messages: Body[] }> }) =>
  body.contacts.flatMap((c) => c.messages.map((m) => m.id as number));

async function modules() {
  const { IMessageSync } = await import('../../main/services/iMessageSync');
  const { IntegrationCache } = await import('../../main/services/sync/IntegrationCache');
  const { AuthService } = await import('../../main/services/auth');
  const identity = await import('../../main/services/deviceIdentity');
  return { IMessageSync, IntegrationCache, AuthService, identity };
}

async function setRows(rows: Array<Record<string, unknown>>): Promise<void> {
  const { IntegrationCache } = await modules();
  vi.mocked(IntegrationCache.getAccounts).mockResolvedValue(
    rows as unknown as Awaited<ReturnType<typeof IntegrationCache.getAccounts>>
  );
}

const ownRow = (accountId = MAC_A, status = 'CONNECTED') => ({
  name: 'imessage',
  accountId,
  status,
});
const chatDbFile = () => path.join(env.home, 'Library/Messages/chat.db');

// ── suite ─────────────────────────────────────────────────────────────────

describe('i-message-sync blackbox (device accounts + real progress)', () => {
  let restoreFetch: (() => void) | null = null;

  beforeAll(() => {
    env.home = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-home-'));
    fs.mkdirSync(path.dirname(chatDbFile()), { recursive: true });
    fs.writeFileSync(chatDbFile(), '');
  });

  beforeEach(async () => {
    clearFetchCaptures();
    vi.clearAllMocks();
    env.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-userdata-'));
    env.events = [];
    env.rows = chatDb(1200);
    env.throwOnOpen = null;
    env.hardwareUuid = 'AAAAAAAA-0000-4000-8000-00000000000A';
    env.computerName = "Andy's MacBook Pro";
    uploadStatus = () => 200;
    progressReply = () => ({ status: 200, body: { applied: true } });
    const { AuthService, identity } = await modules();
    identity.resetDeviceIdentityForTests();
    vi.mocked(AuthService.getSession).mockResolvedValue(SESSION);
    await setRows([ownRow()]);
    restoreFetch = installBackend();
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    fs.rmSync(env.userData, { recursive: true, force: true });
  });

  it('total is the COUNT of chat.db message rows, counted before the first upload', async () => {
    const { IMessageSync } = await modules();
    await IMessageSync.sync();

    const bodies = progressBodies();
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.every((b) => b.total === 1200)).toBe(true);
    expect(env.events.indexOf('sql:count')).toBeGreaterThanOrEqual(0);
    expect(env.events.indexOf('sql:count')).toBeLessThan(env.events.indexOf('upload'));
    // Group chats, attachment-only rows and never-replied senders are not uploaded,
    // but every scanned row counts toward done.
    const sent = uploads().flatMap(uploadedIds);
    expect(sent.length).toBeLessThan(1200);
    expect(bodies.at(-1)).toMatchObject({ state: 'synced', done: 1200, total: 1200 });
  });

  it('every uploaded batch posts progress for this Mac with runId, seq, done and total', async () => {
    const { IMessageSync } = await modules();
    await IMessageSync.sync();

    expect(uploads()).toHaveLength(3);
    const calls = progressCalls();
    expect(calls.map((c) => c.url)).toEqual(
      Array(3).fill(`https://backend.test/api/integrations/imessage/accounts/${MAC_A}/progress`)
    );
    expect(calls.every((c) => c.headers.authorization === 'Bearer test-access-token')).toBe(true);
    const bodies = progressBodies();
    expect(bodies.map((b) => [b.seq, b.state, b.done, b.total])).toEqual([
      [1, 'syncing', 500, 1200],
      [2, 'syncing', 1000, 1200],
      [3, 'synced', 1200, 1200],
    ]);
    expect(new Set(bodies.map((b) => b.runId)).size).toBe(1);
    expect(bodies[0]).toMatchObject({ unit: 'messages', phase: 'uploading' });
    // Progress follows the batch it reports: upload, progress, upload, progress, …
    expect(env.events.filter((e) => e !== 'sql:count')).toEqual([
      'upload',
      'progress',
      'upload',
      'progress',
      'upload',
      'progress',
    ]);
  });

  it('a resumed sync continues from its cursor under the same runId; done never regresses', async () => {
    const { IMessageSync } = await modules();
    uploadStatus = (call) => (call === 2 ? 500 : 200);
    await IMessageSync.sync();
    const first = progressBodies();
    expect(first.map((b) => [b.seq, b.state, b.done])).toEqual([
      [1, 'syncing', 500],
      [2, 'syncing', 500],
    ]);
    expect(String(first[1].error)).toContain('will retry');

    env.rows.push(...chatDb(5, 1201)); // arrives mid-run: belongs to the next run
    uploadStatus = () => 200;
    clearFetchCaptures();
    await IMessageSync.sync();
    const resumed = progressBodies();
    expect(resumed.map((b) => [b.seq, b.state, b.done, b.total])).toEqual([
      [3, 'syncing', 1000, 1200],
      [4, 'synced', 1200, 1200],
    ]);
    expect(resumed.every((b) => b.runId === first[0].runId)).toBe(true);
    const resent = uploads().flatMap(uploadedIds);
    expect(Math.min(...resent)).toBeGreaterThan(500);
    expect(Math.max(...resent)).toBeLessThanOrEqual(1200);
    const done = [...first, ...resumed].map((b) => b.done as number);
    expect(done).toEqual([...done].sort((a, b) => a - b));

    clearFetchCaptures();
    await IMessageSync.sync();
    const next = progressBodies();
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ seq: 1, state: 'synced', done: 5, total: 5 });
    expect(next[0].runId).not.toBe(first[0].runId);
    expect(
      uploads()
        .flatMap(uploadedIds)
        .every((id) => id > 1200)
    ).toBe(true);
  });

  it("accountId is this Mac's device id, so two Macs are two accounts", async () => {
    const { IMessageSync, identity } = await modules();
    await IMessageSync.sync();
    const macA = uploads()[0].account as Body;
    expect(macA).toEqual({ id: MAC_A, label: "Andy's MacBook Pro", mode: 'sync' });
    expect(MAC_A).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(uploads())).not.toContain('AAAAAAAA-0000');

    clearFetchCaptures();
    env.hardwareUuid = 'BBBBBBBB-0000-4000-8000-00000000000B';
    env.computerName = "Andy's iMac";
    identity.resetDeviceIdentityForTests();
    const MAC_B = deviceIdOf('BBBBBBBB-0000-4000-8000-00000000000B');
    await IMessageSync.sync();
    expect(MAC_B).not.toBe(MAC_A);
    expect(uploads()[0].account).toEqual({ id: MAC_B, label: "Andy's iMac", mode: 'connect' });
    expect(progressCalls().every((c) => c.url.includes(`/accounts/${MAC_B}/progress`))).toBe(true);
    // Mac B keeps its own cursor: it uploads its whole chat.db as a new account.
    expect(progressBodies().at(-1)).toMatchObject({ state: 'synced', done: 1200, total: 1200 });
  });

  it('connect claims the legacy account on the first batch, then sync; cache refreshed', async () => {
    const { IMessageSync, IntegrationCache } = await modules();
    await setRows([{ name: 'imessage', accountId: '', status: 'CONNECTED' }]);
    await IMessageSync.sync();
    expect(uploads().map((u) => (u.account as Body).mode)).toEqual(['connect', 'sync', 'sync']);
    expect(IntegrationCache.invalidate).toHaveBeenCalledTimes(1);
  });

  it('a 202 retryAfterMs holds further syncing writes; the terminal write is still sent', async () => {
    const { IMessageSync } = await modules();
    env.rows = chatDb(1700);
    progressReply = (call) =>
      call === 1
        ? { status: 202, body: { applied: false, reason: 'coalesced', retryAfterMs: 60_000 } }
        : { status: 200, body: { applied: true } };
    await IMessageSync.sync();
    expect(uploads()).toHaveLength(4);
    expect(progressBodies().map((b) => [b.seq, b.state, b.done])).toEqual([
      [1, 'syncing', 500],
      [2, 'synced', 1700],
    ]);
  });

  it('410: the run stops, nothing re-creates the account until the user connects again', async () => {
    const { IMessageSync } = await modules();
    uploadStatus = () => 410;
    await IMessageSync.sync();
    expect(uploads()).toHaveLength(1);
    expect(progressCalls()).toHaveLength(0);

    clearFetchCaptures();
    uploadStatus = () => 200;
    await setRows([{ name: 'imessage', accountId: '', status: 'CONNECTED' }]);
    await IMessageSync.sync();
    expect(fetchCaptures).toHaveLength(0);

    const result = await IMessageSync.connect(null);
    expect(result).toEqual({ success: true });
    expect((uploads()[0].account as Body).mode).toBe('connect');
    expect(progressBodies().at(-1)).toMatchObject({ state: 'synced', done: 1200, total: 1200 });
  });

  it('happy path boundary: bearer upload groups messages by contact handle', async () => {
    const { IMessageSync } = await modules();
    env.rows = chatDb(30);
    await IMessageSync.sync();
    const [call] = fetchCaptures.filter((c) => c.url.endsWith(UPLOAD_PATH));
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`https://backend.test${UPLOAD_PATH}`);
    expect(call.headers.authorization).toBe('Bearer test-access-token');
    expect(call.headers['content-type']).toBe('application/json');
    const body = uploads()[0];
    expect(typeof body.accessedAt).toBe('string');
    const alice = body.contacts.find((c) => (c as Body).contact_id === 'alice@example.com') as Body;
    expect(alice.email).toBe('alice@example.com');
    expect(alice.phoneNumber).toBeNull();
    expect(body.contacts.some((c) => (c as Body).contact_id === '+15555550002')).toBe(false);
  });

  it('empty chat.db: no upload and no progress write', async () => {
    const { IMessageSync } = await modules();
    env.rows = [];
    await IMessageSync.sync();
    expect(fetchCaptures).toHaveLength(0);
  });

  it('unauthenticated or no Full Disk Access: nothing is read or sent', async () => {
    const { IMessageSync, AuthService } = await modules();
    vi.mocked(AuthService.getSession).mockResolvedValueOnce(null);
    await IMessageSync.sync();
    fs.renameSync(chatDbFile(), `${chatDbFile()}.away`);
    try {
      await IMessageSync.sync();
    } finally {
      fs.renameSync(`${chatDbFile()}.away`, chatDbFile());
    }
    expect(env.events).toEqual([]);
    expect(fetchCaptures).toHaveLength(0);
  });

  it.each([
    ['NOT_CONNECTED', [{ name: 'imessage', accountId: '', status: 'NOT_CONNECTED' }]],
    ['missing', []],
    [
      'SYNCING within the last hour',
      [
        {
          name: 'imessage',
          accountId: '',
          status: 'SYNCING',
          lastSyncAt: new Date().toISOString(),
        },
      ],
    ],
  ])('scheduled sync skips when the integration is %s', async (_label, rows) => {
    const { IMessageSync } = await modules();
    await setRows(rows);
    await IMessageSync.sync();
    expect(fetchCaptures).toHaveLength(0);
  });

  it('a SYNCING row older than an hour is re-synced', async () => {
    const { IMessageSync } = await modules();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await setRows([
      { name: 'imessage', accountId: '', status: 'SYNCING', lastSyncAt: twoHoursAgo },
    ]);
    await IMessageSync.sync();
    expect(uploads()).toHaveLength(3);
  });

  it('a failed upload or unreadable chat.db never throws out of the sync tick', async () => {
    const { IMessageSync } = await modules();
    uploadStatus = () => 500;
    await expect(IMessageSync.sync()).resolves.toBeUndefined();
    expect(fetchCaptures.filter((c) => c.url.endsWith(UPLOAD_PATH))[0].responseStatus).toBe(500);

    clearFetchCaptures();
    env.throwOnOpen = new Error('database is locked');
    await expect(IMessageSync.sync()).resolves.toBeUndefined();
    expect(fetchCaptures.filter((c) => c.url.endsWith(UPLOAD_PATH))).toHaveLength(0);
  });

  it("real-time messages upload to this Mac's account in sync mode, and only when it exists", async () => {
    const { IMessageReader } = await import('../../main/services/iMessageReader');
    const { handleSyncEvent } = await import('../../main/domains/i-message-sync/service');
    env.rows = chatDb(3, 1300);
    const messages = IMessageReader.toNormalizedMessages(
      await IMessageReader.readMessagesSinceRowId(1299)
    );
    await handleSyncEvent({ type: 'new_messages', messages } as never);
    expect(uploads()).toHaveLength(1);
    expect(uploads()[0].account).toMatchObject({ id: MAC_A, mode: 'sync' });

    clearFetchCaptures();
    await setRows([ownRow('another-mac')]);
    await handleSyncEvent({ type: 'new_messages', messages } as never);
    expect(fetchCaptures).toHaveLength(0);
  });

  it('real-time watcher start/stop is idempotent and needs chat.db access', async () => {
    const { IMessageSync } = await modules();
    expect(IMessageSync.isRealTimeSyncActive()).toBe(false);
    IMessageSync.startRealTimeSync();
    IMessageSync.startRealTimeSync();
    expect(IMessageSync.isRealTimeSyncActive()).toBe(true);
    IMessageSync.stopRealTimeSync();
    IMessageSync.stopRealTimeSync();
    expect(IMessageSync.isRealTimeSyncActive()).toBe(false);

    fs.renameSync(chatDbFile(), `${chatDbFile()}.away`);
    try {
      IMessageSync.startRealTimeSync();
    } finally {
      fs.renameSync(`${chatDbFile()}.away`, chatDbFile());
    }
    expect(IMessageSync.isRealTimeSyncActive()).toBe(false);
  });
});
