/**
 * messaging-telegram blackbox: multi-account sessions + real sync progress
 * (plan row I8). Companion to messaging-telegram.blackbox.ts, which covers the
 * credentials-ABSENT branches; this file loads the domain with credentials
 * present and a scripted GramJS fake so the connected paths run end to end.
 *
 *   telegram-auth/accounts/<telegram user id>/session.txt   one session per account
 *        │ connectWithExistingSession (+ legacy session.txt migration)
 *        ▼
 *   TelegramSync ── POST /telegram/connect {accountId,label,claimLegacy?}
 *        │ syncHistorical(accountId)
 *        ├── chat list (getDialogs)            → total = chats in the list
 *        ├── per batch: history → POST /telegram/upload {accountId, contacts}
 *        └── per batch: POST /telegram/accounts/<id>/progress {done, total, unit:'chats'}
 *
 * Observable behaviour asserted at the fetch boundary and on disk:
 *   - two accounts keep separate session dirs, connect, register and list separately
 *   - progress total = chat-list size; done = chats whose history was saved, per batch
 *   - a 202 coalesced progress write is resent after retryAfterMs with the latest counts
 *   - an unreadable chat or a failed upload is not counted and ends the run `failed`
 *   - logging out one account leaves the other connected and on disk
 *   - the legacy single session migrates into its account dir and claims once
 *   - adding a second account while the first is connected keeps both
 *   - real-time messages upload under the account that received them
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { stubAllElectron } from './electron-stubs';
import { installFetchCapture, clearFetchCaptures, fetchCaptures } from './fetch-capture';

const gram = vi.hoisted(() => {
  const userDataDir = `/tmp/mac-app-test-telegram-accounts-${process.pid}`;
  process.env.MAC_APP_TEST_USER_DATA = userDataDir;
  process.env.TELEGRAM_API_ID = '12345';
  process.env.TELEGRAM_API_HASH = 'test-hash';

  class PeerUser {
    constructor(readonly userId: number) {}
  }
  class PeerChat {
    constructor(readonly chatId: number) {}
  }
  class PeerChannel {
    constructor(readonly channelId: number) {}
  }
  class LogOut {}
  const Api = { auth: { LogOut }, PeerUser, PeerChat, PeerChannel, Message: class Message {} };

  interface Fixture {
    me: { id: number; username?: string; firstName?: string; lastName?: string };
    dialogs: Array<{ id: string; title: string }>;
    messages: Record<string, unknown[]>;
    unreadable?: Set<string>;
  }

  const state = {
    /** session string → the Telegram account it authorizes */
    accounts: new Map<string, Fixture>(),
    /** login code → session string the interactive login produces */
    logins: new Map<string, string>(),
    loggedOut: [] as string[],
    clients: [] as FakeGram[],
  };

  class FakeGram {
    session: { save: () => string };
    handlers: Array<(event: unknown) => void> = [];
    private sessionString: string;

    constructor(session: { save: () => string }) {
      this.sessionString = session.save();
      this.session = { save: () => this.sessionString };
      state.clients.push(this);
    }

    private fixture(): Fixture {
      const fixture = state.accounts.get(this.sessionString);
      if (fixture === undefined) throw new Error('AUTH_KEY_UNREGISTERED');
      return fixture;
    }

    sessionKey(): string {
      return this.sessionString;
    }

    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
    async isUserAuthorized(): Promise<boolean> {
      return state.accounts.has(this.sessionString);
    }
    async getMe(): Promise<Fixture['me']> {
      return this.fixture().me;
    }
    async getDialogs({ limit }: { limit: number }): Promise<unknown[]> {
      return this.fixture()
        .dialogs.slice(0, limit)
        .map((d) => ({ id: d.id, title: d.title, isGroup: false, isChannel: false }));
    }
    async getMessages(dialogId: string, { limit }: { limit: number }): Promise<unknown[]> {
      const fixture = this.fixture();
      if (fixture.unreadable?.has(dialogId) === true) throw new Error('CHANNEL_PRIVATE');
      return (fixture.messages[dialogId] ?? []).slice(0, limit);
    }
    async invoke(request: unknown): Promise<unknown> {
      if (request instanceof LogOut) state.loggedOut.push(this.sessionString);
      return {};
    }
    addEventHandler(handler: (event: unknown) => void): void {
      this.handlers.push(handler);
    }
    async start(options: { phoneCode: () => Promise<string> }): Promise<void> {
      const code = await options.phoneCode();
      const session = state.logins.get(code);
      if (session === undefined) throw new Error('PHONE_CODE_INVALID');
      this.sessionString = session;
    }
  }

  return { Api, state, FakeGram, userDataDir };
});

vi.mock('telegram', () => ({ TelegramClient: gram.FakeGram, Api: gram.Api }));
vi.mock('telegram/tl', () => ({ Api: gram.Api }));
vi.mock('telegram/events', () => ({ NewMessage: class NewMessage {} }));
vi.mock('telegram/sessions', () => ({
  StringSession: class StringSession {
    constructor(private readonly value: string = '') {}
    save(): string {
      return this.value;
    }
  },
}));

stubAllElectron();

vi.mock('../../main/services/auth', () => ({
  AuthService: { getSession: vi.fn(async () => ({ access_token: 'tg-token' })) },
}));

vi.mock('../../main/services/sync/IntegrationCache', () => ({
  IntegrationCache: {
    isConnected: vi.fn(async () => true),
    getConnected: vi.fn(async () => new Set(['telegram'])),
    getIntegration: vi.fn(async () => ({ name: 'telegram', status: 'CONNECTED', config: {} })),
    getIntegrationAccount: vi.fn(async () => undefined),
    invalidate: vi.fn(),
  },
}));

import { TelegramAuth } from '../../main/services/messaging/platforms/telegram/TelegramAuth';
import { TelegramSync } from '../../main/services/messaging/platforms/telegram/TelegramSync';
import { ProgressReporter } from '../../main/domains/messaging-telegram/service.progress';
import type { ProgressBody } from '../../main/domains/messaging-telegram/types';
import { StringSession } from 'telegram/sessions';

const AUTH_DIR = path.join(gram.userDataDir, 'telegram-auth');
const accountSessionPath = (id: string) => path.join(AUTH_DIR, 'accounts', id, 'session.txt');

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function message(id: number, from: number, text: string): unknown {
  return { id, text, peerId: new gram.Api.PeerUser(from), date: 1_760_000_000 + id, out: false };
}

/** An account with `chats` one-message private chats (dialog d<n> with user 5000+n). */
function addAccount(session: string, id: number, chats: number, me: Record<string, string> = {}) {
  const dialogs = Array.from({ length: chats }, (_, i) => ({
    id: `d${i + 1}`,
    title: `Chat ${i + 1}`,
  }));
  const messages: Record<string, unknown[]> = {};
  dialogs.forEach((dialog, i) => {
    messages[dialog.id] = [message(i + 1, 5001 + i, `hello ${dialog.id}`)];
  });
  const fixture = { me: { id, ...me }, dialogs, messages, unreadable: new Set<string>() };
  gram.state.accounts.set(session, fixture);
  return fixture;
}

function saveAccount(session: string, id: string, label: string | null = null): void {
  TelegramAuth.saveAccountSession(id, new StringSession(session), { label });
}

const capturesFor = (fragment: string) => fetchCaptures.filter((c) => c.url.includes(fragment));
const bodyOf = (capture: { body: string | null }) => JSON.parse(capture.body ?? '{}');

describe('messaging-telegram > multi-account sessions and sync progress', () => {
  let restoreFetch: (() => void) | null = null;
  let progressResponder: (n: number) => Response = () => json({ applied: true });

  beforeEach(async () => {
    await TelegramSync.disconnect().catch(() => undefined);
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    gram.state.accounts.clear();
    gram.state.logins.clear();
    gram.state.loggedOut.length = 0;
    gram.state.clients.length = 0;
    clearFetchCaptures();
    progressResponder = () => json({ applied: true });
    let progressCalls = 0;
    restoreFetch = installFetchCapture({
      '/api/integrations/telegram/connect': () => json({ message: 'ok' }),
      '/api/integrations/telegram/upload': () => json({ message: 'ok', jobId: 'j' }),
      '/progress': () => progressResponder(++progressCalls),
    });
  });

  afterEach(async () => {
    await TelegramSync.disconnect().catch(() => undefined);
    restoreFetch?.();
    restoreFetch = null;
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  });

  it('two accounts keep separate session dirs; clearing one keeps the other', () => {
    saveAccount('S-A', '1001', '@alice');
    saveAccount('S-B', '1002', 'Bob W');

    expect(fs.readFileSync(accountSessionPath('1001'), 'utf-8')).toBe('S-A');
    expect(fs.readFileSync(accountSessionPath('1002'), 'utf-8')).toBe('S-B');
    expect(TelegramAuth.listAccountIds()).toEqual(['1001', '1002']);
    expect(TelegramAuth.hasSession()).toBe(true);

    TelegramAuth.clearAccountSession('1001');
    expect(TelegramAuth.listAccountIds()).toEqual(['1002']);
    expect(fs.existsSync(accountSessionPath('1002'))).toBe(true);
    expect(() => TelegramAuth.clearAccountSession('../telegram-auth')).toThrow();
  });

  it('connects every saved account and registers each by its Telegram user id', async () => {
    addAccount('S-A', 1001, 1, { username: 'alice' });
    addAccount('S-B', 1002, 1, { firstName: 'Bob', lastName: 'W' });
    saveAccount('S-A', '1001');
    saveAccount('S-B', '1002');

    expect(await TelegramSync.connectWithExistingSession()).toBe(true);
    expect(TelegramSync.listAccounts()).toEqual([
      { accountId: '1001', label: '@alice', connected: true },
      { accountId: '1002', label: 'Bob W', connected: true },
    ]);

    expect(await TelegramSync.registerConnectedAccounts()).toBe(2);
    const bodies = capturesFor('/telegram/connect').map(bodyOf);
    expect(bodies).toEqual([
      { accountId: '1001', label: '@alice' },
      { accountId: '1002', label: 'Bob W' },
    ]);
    expect(capturesFor('/telegram/connect')[0].headers['authorization']).toBe('Bearer tg-token');
  });

  it('progress: total = chats in the chat list, done = chats saved, posted per batch', async () => {
    addAccount('S-A', 1001, 25);
    addAccount('S-B', 1002, 3);
    saveAccount('S-A', '1001');
    saveAccount('S-B', '1002');
    await TelegramSync.connectWithExistingSession();

    expect(await TelegramSync.syncHistorical(100, '1001')).toBe(25);

    const uploads = capturesFor('/telegram/upload').map(bodyOf);
    expect(uploads.map((u) => u.accountId)).toEqual(['1001', '1001', '1001']);
    expect(uploads.map((u) => u.contacts.length)).toEqual([10, 10, 5]);

    const progress = capturesFor('/progress');
    expect(
      progress.every((c) => c.url.endsWith('/api/integrations/telegram/accounts/1001/progress'))
    ).toBe(true);
    const writes = progress.map(bodyOf) as ProgressBody[];
    expect(writes.map((w) => [w.state, w.done, w.total])).toEqual([
      ['syncing', 0, 25],
      ['syncing', 10, 25],
      ['syncing', 20, 25],
      ['synced', 25, 25],
    ]);
    expect(writes.every((w) => w.unit === 'chats')).toBe(true);
    // eta: unknown before any chat is saved, measured rate while syncing, cleared at the end.
    expect(writes[0].eta_sec).toBeNull();
    expect(writes.slice(1, 3).every((w) => Number.isInteger(w.eta_sec) && w.eta_sec! >= 0)).toBe(
      true
    );
    expect(writes[3].eta_sec).toBeNull();
    expect(new Set(writes.map((w) => w.runId)).size).toBe(1);
    expect(writes.map((w) => w.seq)).toEqual([1, 2, 3, 4]);

    // done advances only after the batch that saved those chats was uploaded.
    const order = fetchCaptures
      .filter((c) => c.url.includes('/upload') || c.url.includes('/progress'))
      .map((c) => (c.url.includes('/upload') ? 'U' : `P${String(bodyOf(c).done)}`));
    expect(order).toEqual(['P0', 'U', 'P10', 'U', 'P20', 'U', 'P25']);
  });

  it('a 202 coalesced write is resent after retryAfterMs with the latest counts', async () => {
    vi.useFakeTimers();
    try {
      const sent: ProgressBody[] = [];
      const replies = [{ kind: 'applied' }, { kind: 'coalesced', retryAfterMs: 1_000 }];
      const reporter = new ProgressReporter('run-1', async (body) => {
        sent.push(body);
        return (replies.shift() ?? { kind: 'applied' }) as never;
      });
      const update = (done: number) => ({
        state: 'syncing' as const,
        done,
        total: 30,
        unit: 'chats',
      });

      reporter.report(update(0));
      await vi.advanceTimersByTimeAsync(0);
      reporter.report(update(10)); // answered 202 retryAfterMs 1000
      await vi.advanceTimersByTimeAsync(0);
      reporter.report(update(20)); // inside the window: held, not sent
      await vi.advanceTimersByTimeAsync(999);
      expect(sent.map((b) => b.done)).toEqual([0, 10]);

      await vi.advanceTimersByTimeAsync(1);
      expect(sent.map((b) => b.done)).toEqual([0, 10, 20]);
      expect(sent.map((b) => b.seq)).toEqual([1, 2, 3]);

      replies.push({ kind: 'coalesced', retryAfterMs: 5_000 });
      reporter.report(update(25));
      await vi.advanceTimersByTimeAsync(0);
      // A terminal write is a transition: it goes out at once, the pending retry is dropped.
      await reporter.finish({ state: 'synced', done: 30, total: 30, unit: 'chats' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent.map((b) => [b.state, b.done])).toEqual([
        ['syncing', 0],
        ['syncing', 10],
        ['syncing', 20],
        ['syncing', 25],
        ['synced', 30],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unreadable chat is not counted and the run ends failed', async () => {
    const fixture = addAccount('S-A', 1001, 4);
    fixture.unreadable.add('d2');
    saveAccount('S-A', '1001');
    await TelegramSync.connectWithExistingSession();

    expect(await TelegramSync.syncHistorical(100, '1001')).toBe(3);
    const writes = capturesFor('/progress').map(bodyOf) as ProgressBody[];
    const last = writes[writes.length - 1];
    expect(last.state).toBe('failed');
    expect(last.done).toBe(3);
    expect(last.total).toBe(4);
    expect(last.error).toMatch(/1 of 4 chats/);
  });

  it('a failed upload stops the run: later chats are not uploaded or counted', async () => {
    addAccount('S-A', 1001, 25);
    saveAccount('S-A', '1001');
    await TelegramSync.connectWithExistingSession();
    let uploads = 0;
    restoreFetch?.();
    restoreFetch = installFetchCapture({
      '/api/integrations/telegram/upload': () =>
        ++uploads === 2 ? json({ error: 'boom' }, 500) : json({ jobId: 'j' }),
      '/progress': () => json({ applied: true }),
    });

    expect(await TelegramSync.syncHistorical(100, '1001')).toBe(10);
    expect(capturesFor('/telegram/upload')).toHaveLength(2);
    const writes = capturesFor('/progress').map(bodyOf) as ProgressBody[];
    expect(writes.map((w) => [w.state, w.done])).toEqual([
      ['syncing', 0],
      ['syncing', 10],
      ['failed', 10],
    ]);
  });

  it('logging out one account leaves the other connected and on disk', async () => {
    addAccount('S-A', 1001, 1);
    addAccount('S-B', 1002, 1);
    saveAccount('S-A', '1001');
    saveAccount('S-B', '1002');
    await TelegramSync.connectWithExistingSession();

    await TelegramSync.logout('1001');

    expect(gram.state.loggedOut).toEqual(['S-A']);
    expect(fs.existsSync(path.join(AUTH_DIR, 'accounts', '1001'))).toBe(false);
    expect(fs.readFileSync(accountSessionPath('1002'), 'utf-8')).toBe('S-B');
    expect(TelegramSync.listAccounts()).toEqual([
      { accountId: '1002', label: null, connected: true },
    ]);
    expect(TelegramSync.isConnected()).toBe(true);
    expect(await TelegramSync.syncHistorical(100, '1001')).toBe(0);
  });

  it('migrates the legacy single session into its account dir and claims it once', async () => {
    addAccount('S-OLD', 1003, 1, { username: 'me' });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    fs.writeFileSync(path.join(AUTH_DIR, 'session.txt'), 'S-OLD', 'utf-8');

    expect(await TelegramSync.connectWithExistingSession()).toBe(true);
    expect(fs.existsSync(path.join(AUTH_DIR, 'session.txt'))).toBe(false);
    expect(fs.readFileSync(accountSessionPath('1003'), 'utf-8')).toBe('S-OLD');

    await TelegramSync.registerConnectedAccounts();
    await TelegramSync.registerConnectedAccounts();
    expect(capturesFor('/telegram/connect').map(bodyOf)).toEqual([
      { accountId: '1003', label: '@me', claimLegacy: true },
      { accountId: '1003', label: '@me' },
    ]);
  });

  it('adding a second account while the first is connected keeps both', async () => {
    addAccount('S-A', 1001, 1, { username: 'alice' });
    addAccount('S-B', 1002, 1, { username: 'bob' });
    gram.state.logins.set('12345', 'S-B');
    saveAccount('S-A', '1001');
    await TelegramSync.connectWithExistingSession();

    const completed = new Promise<unknown>((resolve) => {
      void TelegramSync.startAuth('+15550001111').then(() => {
        TelegramSync.getClient()?.once('auth:complete', resolve);
      });
    });
    await vi.waitFor(() => expect(TelegramSync.getClient()?.getAuthState()).toBe('awaiting_code'));
    TelegramSync.submitCode('12345');
    expect(await completed).toEqual({ accountId: '1002', label: '@bob' });

    expect(fs.readFileSync(accountSessionPath('1002'), 'utf-8')).toBe('S-B');
    expect(TelegramSync.listAccounts()).toEqual([
      { accountId: '1001', label: '@alice', connected: true },
      { accountId: '1002', label: '@bob', connected: true },
    ]);
  });

  it('real-time messages upload under the account that received them', async () => {
    addAccount('S-A', 1001, 1);
    addAccount('S-B', 1002, 1);
    saveAccount('S-A', '1001');
    saveAccount('S-B', '1002');
    await TelegramSync.connectWithExistingSession();
    const clientB = gram.state.clients.find(
      (c) => c.sessionKey() === 'S-B' && c.handlers.length > 0
    );
    clientB?.handlers[0]({ message: message(77, 6001, 'live on B') });

    await TelegramSync.disconnect();

    const uploads = capturesFor('/telegram/upload').map(bodyOf);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].accountId).toBe('1002');
    expect(uploads[0].contacts[0].messages[0].text).toBe('live on B');
  });
});
