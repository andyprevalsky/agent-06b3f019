/**
 * messaging-imessage domain blackbox
 *
 * Surface under test:
 *   - main/services/messaging/platforms/imessage/IMessageWatcher.ts
 *   - main/services/messaging/platforms/imessage/index.ts  (barrel)
 *   - main/services/messaging/types.ts                     (NormalizedMessage, SyncEvent, MessageChannel)
 *
 * The IMessageWatcher wraps a real `fs.watch` on `~/Library/Messages/chat.db`:
 *   - 'change' events debounce (1000ms) → call the injected queryNewMessages() →
 *     if any messages returned, emit a 'sync' event of type 'new_messages' and
 *     advance `lastMessageRowId` to max(id).
 *   - If queryNewMessages throws, emit a 'sync' event of type 'error'.
 *   - If the underlying fs.watch instance emits 'error', forward it as a 'sync'
 *     event of type 'error'.
 *   - start()/stop() are idempotent and toggle `isActive()`.
 *
 * This suite exercises the observable surface by replacing `fs.watch` with a
 * fake that exposes the callback + a lightweight error emitter. The watcher's
 * dependency on Electron's `app.getPath('home')` is stubbed via electron-stubs.
 *
 * Scope deferrals (per batch prompt):
 *   - flake×5 reruns, concurrent invocations, negative-control checks,
 *     broader-suite verification.
 *   - IMessageSync integration (covered by i-message-sync.blackbox.ts).
 *   - MessageTransformer / Uploader fetch boundary (covered by
 *     messaging-core.blackbox.ts).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubAllElectron } from './electron-stubs';
import { installFetchCapture, clearFetchCaptures, fetchCaptures } from './fetch-capture';
import type { NormalizedMessage, SyncEvent } from '../../main/services/messaging/types';

// Config reads env vars at module-load time — provide sane fakes before any
// import that transitively pulls `main/base/config.ts`.
process.env.VITE_SUPABASE_URL ??= 'https://test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.VITE_BACKEND_API_URL ??= 'http://localhost:3001';
process.env.ENCRYPTION_KEY ??= 'test-encryption-key';

stubAllElectron();

// vi.hoisted runs before vi.mock factories execute, so the shared state is
// guaranteed to exist when the fs module replacement is bound.
const fsMockState = vi.hoisted(() => ({
  fsWatchCalls: [] as Array<{
    close: ReturnType<typeof vi.fn>;
    _path: string;
    _listener: (eventType: string, filename: string | null) => void;
    emit: (name: string, ...args: unknown[]) => boolean;
    on: (name: string, listener: (...args: unknown[]) => void) => unknown;
  }>,
  nextWatchShouldThrow: null as Error | null,
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const { EventEmitter: EE } = await import('events');
  const watch = vi.fn(
    (path: string, listener: (eventType: string, filename: string | null) => void) => {
      if (fsMockState.nextWatchShouldThrow) {
        const err = fsMockState.nextWatchShouldThrow;
        fsMockState.nextWatchShouldThrow = null;
        throw err;
      }
      const handle = Object.assign(new EE(), {
        close: vi.fn(),
        _path: path,
        _listener: listener,
      });
      fsMockState.fsWatchCalls.push(handle);
      return handle;
    }
  );
  return {
    ...actual,
    default: { ...actual, watch },
    watch,
  };
});

const fsWatchCalls = fsMockState.fsWatchCalls;

async function loadWatcherModule() {
  return import('../../main/services/messaging/platforms/imessage/IMessageWatcher');
}

function makeMsg(overrides: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    id: '1',
    text: 'hi',
    timestamp: new Date('2024-01-01T00:00:00Z'),
    isFromMe: false,
    chatId: 'chat',
    contactId: 'c1',
    channel: 'IMESSAGE',
    ...overrides,
  };
}

describe('messaging-imessage > IMessageWatcher', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    fsWatchCalls.length = 0;
    fsMockState.nextWatchShouldThrow = null;
    clearFetchCaptures();
    vi.useFakeTimers();
    // Install a fetch capture even though the watcher shouldn't touch the
    // network — that's the auth-boundary assertion.
    restoreFetch = installFetchCapture({});
  });

  afterEach(() => {
    vi.useRealTimers();
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  it('boundary capture: start() calls fs.watch with the chat.db path under the stubbed home dir', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const watcher = new IMessageWatcher(async () => []);

    watcher.start();

    expect(fsWatchCalls).toHaveLength(1);
    // electron-stubs makes app.getPath() return '/tmp/mac-app-test'.
    expect(fsWatchCalls[0]._path).toBe('/tmp/mac-app-test/Library/Messages/chat.db');
    expect(watcher.isActive()).toBe(true);

    watcher.stop();
  });

  it('auth boundary: watcher never touches fetch — start/change/stop issue zero HTTP calls', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const query = vi.fn(async () => [makeMsg()]);
    const watcher = new IMessageWatcher(query);

    watcher.start();
    fsWatchCalls[0]._listener('change', 'chat.db');
    await vi.advanceTimersByTimeAsync(1000);
    watcher.stop();

    expect(fetchCaptures).toHaveLength(0);
  });

  it('happy path: change → debounce → query → emit sync with new_messages + advance lastMessageRowId', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const msg = makeMsg({ id: '42', text: 'hello' });
    const query = vi.fn(async () => [msg]);
    const watcher = new IMessageWatcher(query);
    const events: SyncEvent[] = [];
    watcher.on('sync', (evt) => events.push(evt));

    await watcher.initialize(0);
    watcher.start();
    fsWatchCalls[0]._listener('change', 'chat.db');

    // Before the debounce window, nothing should have fired.
    expect(query).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);

    expect(query).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'new_messages',
      channel: 'IMESSAGE',
      messages: [msg],
    });
    expect(watcher.getLastMessageRowId()).toBe(42);

    watcher.stop();
  });

  it('empty state: change → query returns [] → no sync event emitted, lastMessageRowId unchanged', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const query = vi.fn(async () => []);
    const watcher = new IMessageWatcher(query);
    const events: SyncEvent[] = [];
    watcher.on('sync', (evt) => events.push(evt));

    watcher.setLastMessageRowId(7);
    watcher.start();
    fsWatchCalls[0]._listener('change', 'chat.db');
    await vi.advanceTimersByTimeAsync(1000);

    expect(query).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
    expect(watcher.getLastMessageRowId()).toBe(7);

    watcher.stop();
  });

  it('error state: queryNewMessages throws → emits error sync event, watcher stays active, no crash', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const boom = new Error('sqlite locked');
    const query = vi.fn(async () => {
      throw boom;
    });
    const watcher = new IMessageWatcher(query);
    const events: SyncEvent[] = [];
    watcher.on('sync', (evt) => events.push(evt));

    watcher.start();
    fsWatchCalls[0]._listener('change', 'chat.db');
    await vi.advanceTimersByTimeAsync(1000);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect(events[0].error).toBe(boom);
    expect(watcher.isActive()).toBe(true);

    watcher.stop();
  });

  it('error state: fs.watch emits "error" → forwarded as error sync event', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const watcher = new IMessageWatcher(async () => []);
    const events: SyncEvent[] = [];
    watcher.on('sync', (evt) => events.push(evt));

    watcher.start();
    const err = new Error('watcher lost fd');
    fsWatchCalls[0].emit('error', err);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', channel: 'IMESSAGE', error: err });

    watcher.stop();
  });

  it('start() propagates failures when fs.watch throws synchronously', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const watcher = new IMessageWatcher(async () => []);
    fsMockState.nextWatchShouldThrow = new Error('ENOENT');

    expect(() => watcher.start()).toThrowError('ENOENT');
    expect(watcher.isActive()).toBe(false);
  });

  it('start() is idempotent — calling twice does not open a second fs.watch handle', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const watcher = new IMessageWatcher(async () => []);

    watcher.start();
    watcher.start();

    expect(fsWatchCalls).toHaveLength(1);
    expect(watcher.isActive()).toBe(true);

    watcher.stop();
  });

  it('stop() closes the fs.watch handle, clears debounce, and toggles isActive to false', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const query = vi.fn(async () => [makeMsg()]);
    const watcher = new IMessageWatcher(query);

    watcher.start();
    const handle = fsWatchCalls[0];
    // Arm the debounce timer but stop before it fires.
    handle._listener('change', 'chat.db');
    watcher.stop();

    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(watcher.isActive()).toBe(false);

    // The pending debounced query must NOT fire after stop().
    await vi.advanceTimersByTimeAsync(2000);
    expect(query).not.toHaveBeenCalled();
  });

  it('stop() is safe to call when start() was never invoked', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const watcher = new IMessageWatcher(async () => []);

    expect(() => watcher.stop()).not.toThrow();
    expect(watcher.isActive()).toBe(false);
  });

  it('debounce: rapid change events collapse to a single queryNewMessages call', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const query = vi.fn(async () => []);
    const watcher = new IMessageWatcher(query);

    watcher.start();
    const listener = fsWatchCalls[0]._listener;
    listener('change', 'chat.db');
    await vi.advanceTimersByTimeAsync(500);
    listener('change', 'chat.db');
    await vi.advanceTimersByTimeAsync(500);
    listener('change', 'chat.db');
    // Still within the debounce window after the latest change.
    expect(query).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);

    expect(query).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  it('non-"change" fs.watch events are ignored (no query triggered)', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const query = vi.fn(async () => []);
    const watcher = new IMessageWatcher(query);

    watcher.start();
    fsWatchCalls[0]._listener('rename', 'chat.db');
    await vi.advanceTimersByTimeAsync(5000);

    expect(query).not.toHaveBeenCalled();

    watcher.stop();
  });

  it('lastMessageRowId advances to the max id across a batch of new messages', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const query = vi.fn(async () => [
      makeMsg({ id: '3' }),
      makeMsg({ id: '10' }),
      makeMsg({ id: '7' }),
    ]);
    const watcher = new IMessageWatcher(query);

    watcher.setLastMessageRowId(5);
    watcher.start();
    fsWatchCalls[0]._listener('change', 'chat.db');
    await vi.advanceTimersByTimeAsync(1000);

    expect(watcher.getLastMessageRowId()).toBe(10);

    watcher.stop();
  });

  it('lastMessageRowId does NOT regress when new max is lower than current', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const query = vi.fn(async () => [makeMsg({ id: '2' })]);
    const watcher = new IMessageWatcher(query);

    watcher.setLastMessageRowId(100);
    watcher.start();
    fsWatchCalls[0]._listener('change', 'chat.db');
    await vi.advanceTimersByTimeAsync(1000);

    expect(watcher.getLastMessageRowId()).toBe(100);

    watcher.stop();
  });

  it('initialize(lastRowId) seeds the baseline row id; initialize() without args is a no-op', async () => {
    const { IMessageWatcher } = await loadWatcherModule();
    const watcher = new IMessageWatcher(async () => []);

    expect(watcher.getLastMessageRowId()).toBe(0);

    await watcher.initialize(999);
    expect(watcher.getLastMessageRowId()).toBe(999);

    await watcher.initialize();
    expect(watcher.getLastMessageRowId()).toBe(999);
  });
});

describe('messaging-imessage > platform barrel', () => {
  it('imessage/index.ts re-exports IMessageWatcher as a constructable class', async () => {
    const mod = await import('../../main/services/messaging/platforms/imessage');
    expect(typeof mod.IMessageWatcher).toBe('function');
    const instance = new mod.IMessageWatcher(async () => []);
    expect(instance.isActive()).toBe(false);
    expect(typeof instance.start).toBe('function');
    expect(typeof instance.stop).toBe('function');
  });
});

describe('messaging-imessage > shared types contract', () => {
  it('MessageChannel literal "IMESSAGE" is accepted by SyncEvent/NormalizedMessage', async () => {
    // types.ts has no runtime exports; pin the compile-time contract by
    // constructing runtime objects that match the shapes the domain uses.
    const typesMod = await import('../../main/services/messaging/types');
    expect(typesMod).toBeDefined();

    const msg = makeMsg({ id: '1', text: 'x', contactId: 'p', chatId: 'c' });
    const evt: SyncEvent = {
      type: 'new_messages',
      channel: 'IMESSAGE',
      messages: [msg],
    };

    expect(msg.channel).toBe('IMESSAGE');
    expect(evt.type).toBe('new_messages');
    expect(evt.messages?.[0].id).toBe('1');
  });
});
