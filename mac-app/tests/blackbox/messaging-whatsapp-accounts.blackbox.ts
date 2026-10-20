/**
 * messaging-whatsapp: multi-account + history-sync progress (plan row I2)
 *
 *   one Baileys auth dir + socket per linked phone
 *     userData/whatsapp-auth            (legacy single account, kept in place)
 *     userData/whatsapp-accounts/<slot> (every account paired since)
 *          │ messaging-history.set { progress, syncType, chats, messages }
 *          ▼
 *   POST /api/integrations/whatsapp/accounts/<phone>/progress
 *        { runId, seq, state, phase, done = messages saved, total: null, pct, unit }
 *   POST /api/integrations/whatsapp/upload { contacts, accountId: <phone> }
 *
 * Drives the REAL WhatsAppSync runtime and REAL WhatsAppClient over a fake
 * Baileys module (the socket boundary) and a captured fetch (the backend).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { stubAllElectron } from './electron-stubs';
import { fetchCaptures, clearFetchCaptures, installFetchCapture } from './fetch-capture';

process.env.VITE_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.VITE_BACKEND_API_URL ??= 'http://localhost:3001';
process.env.ENCRYPTION_KEY ??= 'test-encryption-key';

stubAllElectron();

vi.mock('@whiskeysockets/baileys', () => ({ default: {} }));
vi.mock('telegram', () => ({ TelegramClient: vi.fn(), Api: {} }));
vi.mock('telegram/sessions', () => ({
  StringSession: vi.fn().mockImplementation((s: string) => ({ save: () => s ?? '' })),
}));
vi.mock('telegram/events', () => ({ NewMessage: vi.fn() }));
vi.mock('telegram/tl', () => ({ Api: {} }));
vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: vi.fn(async () => ({
      access_token: 'test-access-token',
      refresh_token: 'r',
      user: { id: 'user-1' },
      expires_at: Date.now() + 3_600_000,
    })),
    setSession: vi.fn(),
    clearSession: vi.fn(),
  },
}));
vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: {
    isConnected: vi.fn(async () => true),
    getConnected: vi.fn(),
    getIntegration: vi.fn(),
    invalidate: vi.fn(),
  },
}));

/** A fake Baileys socket; `dir` is the auth dir it was opened on. */
interface FakeSock extends EventEmitter {
  ev: EventEmitter;
  ws: EventEmitter & { close: ReturnType<typeof vi.fn> };
  user?: { id: string };
  dir: string;
}

const baileys = vi.hoisted(() => ({
  sockets: [] as FakeSock[],
  authDirs: [] as string[],
}));

vi.mock('../../main/domains/messaging-whatsapp/client-loader', async () => {
  const { EventEmitter: EE } = await import('events');
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  const readMe = (dir: string): string | undefined => {
    try {
      const raw = nodeFs.readFileSync(nodePath.join(dir, 'creds.json'), 'utf-8');
      return (JSON.parse(raw) as { me?: { id?: string } }).me?.id;
    } catch {
      return undefined;
    }
  };
  return {
    loadBaileys: vi.fn(async () => ({
      useMultiFileAuthState: vi.fn(async (dir: string) => {
        baileys.authDirs.push(dir);
        const sockRef: { sock?: FakeSock } = {};
        const creds = { me: readMe(dir) === undefined ? undefined : { id: readMe(dir) } };
        Object.defineProperty(creds, '__dir', { value: dir, enumerable: false });
        Object.defineProperty(creds, '__sockRef', { value: sockRef, enumerable: false });
        return {
          state: { creds, keys: {} },
          saveCreds: vi.fn(async () => {
            const id = sockRef.sock?.user?.id;
            if (id === undefined) return;
            nodeFs.mkdirSync(dir, { recursive: true });
            nodeFs.writeFileSync(nodePath.join(dir, 'creds.json'), JSON.stringify({ me: { id } }));
          }),
        };
      }),
      makeWASocket: vi.fn((cfg: { auth: { creds: Record<string, unknown> } }) => {
        const creds = cfg.auth.creds as { me?: { id: string }; __dir: string };
        const sockRef = (cfg.auth.creds as { __sockRef: { sock?: FakeSock } }).__sockRef;
        const sock = Object.assign(new EE(), {
          ev: new EE(),
          ws: Object.assign(new EE(), { close: vi.fn() }),
          user: creds.me === undefined ? undefined : { id: creds.me.id },
          dir: creds.__dir,
        }) as FakeSock;
        sockRef.sock = sock;
        baileys.sockets.push(sock);
        // Resolve after the client has attached its handlers.
        void Promise.resolve().then(() => {
          if (sock.user !== undefined) sock.ev.emit('connection.update', { connection: 'open' });
          else sock.ev.emit('connection.update', { qr: `QR-${baileys.sockets.length}` });
        });
        return sock;
      }),
      fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 0, 0] })),
      makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
    })),
    resetBaileysCache: vi.fn(),
    silentBaileysLogger: { level: 'silent', child: () => ({}) },
  };
});

const PHONE_A = '+15550001111';
const PHONE_B = '+15550002222';
const JID_A = '15550001111:3@s.whatsapp.net';
const JID_B = '15550002222:7@s.whatsapp.net';
const PROGRESS_PATH = '/api/integrations/whatsapp/accounts/';
const UPLOAD_PATH = '/api/integrations/whatsapp/upload';
const CONNECT_PATH = '/api/integrations/whatsapp/connect';

let userData = '';
let restoreFetch: (() => void) | null = null;
let progressResponder: (n: number) => Response = () => json(200, { applied: true });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function writeCreds(dir: string, jid: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify({ me: { id: jid } }));
}

const legacyDir = () => path.join(userData, 'whatsapp-auth');
const accountsRoot = () => path.join(userData, 'whatsapp-accounts');

type Body = Record<string, unknown>;
const bodies = (pathPart: string): Body[] =>
  fetchCaptures
    .filter((c) => c.url.includes(pathPart))
    .map((c) => JSON.parse(c.body ?? '{}') as Body);
const progressCalls = () => fetchCaptures.filter((c) => c.url.includes(PROGRESS_PATH));
const progressBodies = () => bodies(PROGRESS_PATH);

function waMessage(fromJid: string, id: string, text: string) {
  return {
    key: { remoteJid: fromJid, id, fromMe: false },
    message: { conversation: text },
    messageTimestamp: 1_700_000_000,
    pushName: 'Peer',
  };
}

function historySet(
  sock: FakeSock,
  opts: { progress?: number | null; messages?: unknown[]; chats?: number; syncType?: number }
): void {
  sock.ev.emit('messaging-history.set', {
    chats: Array.from({ length: opts.chats ?? 0 }, (_, i) => ({ id: `chat-${i}` })),
    contacts: [],
    messages: opts.messages ?? [],
    isLatest: true,
    progress: opts.progress,
    syncType: opts.syncType ?? 2,
  });
}

function socketFor(dirPrefix: string): FakeSock {
  const sock = [...baileys.sockets].reverse().find((s) => s.dir.startsWith(dirPrefix));
  if (sock === undefined) throw new Error(`no socket opened under ${dirPrefix}`);
  return sock;
}

async function loadSync() {
  const { WhatsAppSync } =
    await import('../../main/services/messaging/platforms/whatsapp/WhatsAppSync');
  return WhatsAppSync;
}

beforeEach(async () => {
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-accounts-test-'));
  process.env.MAC_APP_TEST_USER_DATA = userData;
  const { resetWhatsAppAuthDirCache } =
    await import('../../main/domains/messaging-whatsapp/config');
  resetWhatsAppAuthDirCache();
  baileys.sockets.length = 0;
  baileys.authDirs.length = 0;
  clearFetchCaptures();
  let progressCount = 0;
  progressResponder = () => json(200, { applied: true });
  restoreFetch = installFetchCapture({
    [PROGRESS_PATH]: () => progressResponder(++progressCount),
    [UPLOAD_PATH]: () => json(200, { ok: true }),
    [CONNECT_PATH]: () => json(200, { message: 'WhatsApp connected successfully' }),
  });
});

afterEach(async () => {
  const sync = await loadSync();
  await sync.disconnect();
  await sync.logout();
  vi.useRealTimers();
  restoreFetch?.();
  restoreFetch = null;
  fs.rmSync(userData, { recursive: true, force: true });
  delete process.env.MAC_APP_TEST_USER_DATA;
});

const fakeTimers = () =>
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });

describe('messaging-whatsapp > history-sync progress', () => {
  it('posts the Baileys progress as pct with total null and done = messages saved', async () => {
    writeCreds(legacyDir(), JID_A);
    fakeTimers();
    const sync = await loadSync();
    await sync.connect();
    expect(bodies(CONNECT_PATH)).toEqual([{ accountId: PHONE_A, label: PHONE_A }]);

    const sock = socketFor(legacyDir());
    historySet(sock, {
      progress: 40,
      chats: 2,
      messages: [
        waMessage('15559990001@s.whatsapp.net', 'm1', 'one'),
        waMessage('15559990001@s.whatsapp.net', 'm2', 'two'),
        waMessage('15559990002@s.whatsapp.net', 'm3', 'three'),
      ],
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(progressCalls()[0].url).toBe(
      `http://localhost:3001${PROGRESS_PATH}${encodeURIComponent(PHONE_A)}/progress`
    );
    expect(progressBodies()[0]).toMatchObject({
      seq: 1,
      state: 'syncing',
      phase: 'full',
      done: 0,
      total: null,
      pct: 40,
      unit: 'messages',
    });
    expect(typeof progressBodies()[0].runId).toBe('string');

    await vi.advanceTimersByTimeAsync(5_000); // periodic flush uploads the batch
    const uploads = bodies(UPLOAD_PATH);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].accountId).toBe(PHONE_A);
    const last = progressBodies().at(-1)!;
    expect(last).toMatchObject({ state: 'syncing', done: 3, total: null, pct: 40, seq: 2 });
    expect(last.runId).toBe(progressBodies()[0].runId);
    expect(progressBodies().every((b) => b.total === null)).toBe(true);
  });

  it('never invents a percent when Baileys reports none', async () => {
    writeCreds(legacyDir(), JID_A);
    fakeTimers();
    const sync = await loadSync();
    await sync.connect();
    historySet(socketFor(legacyDir()), {
      progress: null,
      syncType: 3,
      messages: [waMessage('15559990001@s.whatsapp.net', 'm1', 'one')],
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const all = progressBodies();
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((b) => b.pct === null && b.total === null)).toBe(true);
    expect(all[0].phase).toBe('recent');
    expect(all.at(-1)).toMatchObject({ done: 1 });
  });

  it('honours 202 retryAfterMs: one write per window, the latest batch wins', async () => {
    writeCreds(legacyDir(), JID_A);
    fakeTimers();
    progressResponder = (n) =>
      n === 2
        ? json(202, { applied: false, reason: 'coalesced', retryAfterMs: 700 })
        : json(200, { applied: true });
    const sync = await loadSync();
    await sync.connect();
    const sock = socketFor(legacyDir());

    historySet(sock, { progress: 10 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(progressCalls()).toHaveLength(1);

    historySet(sock, { progress: 20 });
    await vi.advanceTimersByTimeAsync(0);
    expect(progressCalls()).toHaveLength(2); // answered 202 coalesced
    for (let p = 21; p <= 30; p++) historySet(sock, { progress: p });
    await vi.advanceTimersByTimeAsync(600);
    expect(progressCalls()).toHaveLength(2); // still inside retryAfterMs

    await vi.advanceTimersByTimeAsync(200);
    expect(progressCalls()).toHaveLength(3);
    expect(progressBodies()[2]).toMatchObject({ pct: 30, seq: 3 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(progressCalls()).toHaveLength(3); // 12 batches → 3 writes
  });
});

describe('messaging-whatsapp > multiple accounts', () => {
  async function connectTwo() {
    writeCreds(legacyDir(), JID_A);
    writeCreds(path.join(accountsRoot(), 'slot-b'), JID_B);
    const sync = await loadSync();
    await sync.connect();
    return { sync, sockA: socketFor(legacyDir()), sockB: socketFor(accountsRoot()) };
  }

  it('opens one socket per account on its own auth dir and attributes uploads', async () => {
    const { sync, sockA, sockB } = await connectTwo();
    expect(baileys.sockets).toHaveLength(2);
    expect(new Set(baileys.authDirs)).toEqual(
      new Set([legacyDir(), path.join(accountsRoot(), 'slot-b')])
    );
    expect(sync.listAccounts()).toEqual([
      { accountId: PHONE_A, connected: true },
      { accountId: PHONE_B, connected: true },
    ]);
    expect(
      bodies(CONNECT_PATH)
        .map((b) => b.accountId)
        .sort()
    ).toEqual([PHONE_A, PHONE_B]);

    sockA.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [waMessage('15559990001@s.whatsapp.net', 'a1', 'to A')],
    });
    sockB.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [waMessage('15559990002@s.whatsapp.net', 'b1', 'to B')],
    });
    await sync.disconnect();

    const uploads = bodies(UPLOAD_PATH);
    expect(uploads.map((u) => u.accountId).sort()).toEqual([PHONE_A, PHONE_B]);
    const idsFor = (accountId: string) =>
      (
        uploads.find((u) => u.accountId === accountId)!.contacts as Array<{
          messages: Array<{ id: string }>;
        }>
      ).flatMap((c) => c.messages.map((m) => m.id));
    expect(idsFor(PHONE_A)).toEqual(['a1']);
    expect(idsFor(PHONE_B)).toEqual(['b1']);
  });

  it('logging out one account leaves the other connected', async () => {
    const { sync, sockA, sockB } = await connectTwo();
    await sync.logout(PHONE_A);

    expect(fs.existsSync(legacyDir())).toBe(false);
    expect(sockA.ws.close).toHaveBeenCalled();
    expect(sockB.ws.close).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(accountsRoot(), 'slot-b', 'creds.json'))).toBe(true);
    expect(sync.isConnected(PHONE_A)).toBe(false);
    expect(sync.isConnected(PHONE_B)).toBe(true);
    expect(sync.listAccounts()).toEqual([{ accountId: PHONE_B, connected: true }]);

    sockB.ev.emit('messages.upsert', {
      type: 'notify',
      messages: [waMessage('15559990002@s.whatsapp.net', 'b2', 'still syncing')],
    });
    await sync.disconnect();
    expect(bodies(UPLOAD_PATH).map((u) => u.accountId)).toEqual([PHONE_B]);
  });

  it('pairs a second account in a new auth dir with its own socket', async () => {
    writeCreds(legacyDir(), JID_A);
    const sync = await loadSync();
    await sync.connect();
    const onQRCode = vi.fn();
    const pairing = sync.addAccount({ onQRCode });
    await vi.waitFor(() => expect(onQRCode).toHaveBeenCalled());

    const sock = baileys.sockets.at(-1)!;
    expect(sock.dir.startsWith(accountsRoot())).toBe(true);
    sock.user = { id: JID_B };
    sock.ev.emit('creds.update', {});
    sock.ev.emit('connection.update', { connection: 'open' });
    await pairing;

    await vi.waitFor(() => expect(fs.existsSync(path.join(sock.dir, 'creds.json'))).toBe(true));
    expect(sync.listAccounts()).toEqual([
      { accountId: PHONE_A, connected: true },
      { accountId: PHONE_B, connected: true },
    ]);
    expect(bodies(CONNECT_PATH).at(-1)).toEqual({ accountId: PHONE_B, label: PHONE_B });
  });

  it('a device logged out by WhatsApp (401) only needs reconnect for that account', async () => {
    const { sync, sockA } = await connectTwo();
    sockA.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await vi.waitFor(() =>
      expect(progressBodies().some((b) => b.state === 'needs_reconnect')).toBe(true)
    );
    const reconnect = progressCalls().find((c) => (c.body ?? '').includes('needs_reconnect'))!;
    expect(reconnect.url).toContain(encodeURIComponent(PHONE_A));
    expect(fs.existsSync(path.join(legacyDir(), 'creds.json'))).toBe(false);
    expect(sync.isConnected(PHONE_B)).toBe(true);
    expect(sync.listAccounts()).toEqual([{ accountId: PHONE_B, connected: true }]);
  });
});
