import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { stubAllElectron } from './electron-stubs';
import {
  installFetchCapture,
  clearFetchCaptures,
  fetchCaptures,
  type MockResponder,
} from './fetch-capture';

// Config reads env vars at module-load time — provide sane fakes before any import
// that transitively pulls `main/base/config.ts`. Save originals so we can restore
// them in afterAll and avoid leaking test env into sibling suites.
const ENV_KEYS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_BACKEND_API_URL',
  'ENCRYPTION_KEY',
] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];

process.env.VITE_SUPABASE_URL = 'https://test.supabase.co';
process.env.VITE_SUPABASE_ANON_KEY = 'test-anon-key';
process.env.VITE_BACKEND_API_URL = 'http://localhost:3001';
process.env.ENCRYPTION_KEY = 'test-encryption-key';

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

stubAllElectron();

// AuthService reads from electron-store (which is stubbed) — mock the boundary so
// tests control session state without touching the real token store.
vi.mock('../../main/services/auth', () => ({
  AuthService: {
    getSession: vi.fn(),
  },
}));

// IMessageSender wraps `osascript` execution — not reachable in jsdom. Mock the
// boundary so tests observe the exact payload handed to the AppleScript layer.
vi.mock('../../main/services/iMessageSender', () => ({
  IMessageSender: {
    send: vi.fn(async () => undefined),
  },
}));

const POP_PATH = '/api/imessage/queue/pop';
const POP_URL = `http://localhost:3001${POP_PATH}`;
const RESULT_PATH = '/api/imessage/queue/';

// Drive the pop endpoint via a queue of responses so each test can script the
// exact sequence the polling loop will observe.
let popQueue: Response[] = [];
let resultQueue: Response[] = [];
const popResponder: MockResponder = () => {
  if (popQueue.length === 0) {
    return new Response(JSON.stringify({ message: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  return popQueue.shift()!;
};
const resultResponder: MockResponder = () =>
  resultQueue.shift() ??
  new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function enqueueMessage(overrides: {
  id?: string;
  phone_number?: string;
  message?: string;
  agent_id?: string;
  claim_token?: string;
}): void {
  popQueue.push(
    new Response(
      JSON.stringify({
        message: {
          id: overrides.id ?? 'msg-1',
          phone_number: overrides.phone_number ?? '+15555551212',
          message: overrides.message ?? 'hello',
          agent_id: overrides.agent_id ?? 'agent-1',
          created_at: '2025-01-01T00:00:00.000Z',
          claim_token: overrides.claim_token ?? `claim-${overrides.id ?? 'msg-1'}`,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  );
}

function enqueueEmpty(): void {
  popQueue.push(
    new Response(JSON.stringify({ message: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  );
}

function enqueueStatus(status: number, body = ''): void {
  popQueue.push(new Response(body, { status, statusText: 'Error' }));
}

const popCalls = () => fetchCaptures.filter((c) => c.url.includes(POP_PATH));
const resultCalls = () =>
  fetchCaptures.filter(
    (capture) => capture.url.includes(RESULT_PATH) && capture.url.endsWith('/result')
  );

describe('i-message-queue-service blackbox', () => {
  let restoreFetch: (() => void) | null = null;

  beforeEach(async () => {
    clearFetchCaptures();
    popQueue = [];
    resultQueue = [];
    vi.clearAllMocks();

    const { AuthService } = await import('../../main/services/auth');
    vi.mocked(AuthService.getSession).mockResolvedValue({
      access_token: 'test-access-token',
      refresh_token: 'test-refresh-token',
      user: { id: 'user-1' },
      expires_at: Date.now() + 60 * 60 * 1000,
    });

    restoreFetch = installFetchCapture({
      [POP_PATH]: popResponder,
      [RESULT_PATH]: resultResponder,
    });

    // Ensure the singleton service is stopped between tests so interval
    // ownership (the class-level `intervalId`) can't leak across cases.
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');
    IMessageQueueService.stop();
  });

  afterEach(async () => {
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');
    IMessageQueueService.stop();
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
  });

  it('unauthenticated: no session → no pop fetch, no send', async () => {
    const { AuthService } = await import('../../main/services/auth');
    const { IMessageSender } = await import('../../main/services/iMessageSender');
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');
    vi.mocked(AuthService.getSession).mockResolvedValue(null);

    IMessageQueueService.start();
    // Allow the immediate first poll microtask to settle.
    await new Promise((r) => setImmediate(r));

    expect(popCalls()).toHaveLength(0);
    expect(vi.mocked(IMessageSender.send)).not.toHaveBeenCalled();
  });

  it('happy path: pop returns a message → sender invoked with exact payload, loop drains queue', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');

    enqueueMessage({ id: 'msg-1', phone_number: '+15555551212', message: 'first' });
    enqueueMessage({ id: 'msg-2', phone_number: '+15555559999', message: 'second' });
    enqueueEmpty();

    IMessageQueueService.start();
    // Three sequential fetches + two sends → wait for queue drain.
    await vi.waitFor(() => {
      expect(popCalls()).toHaveLength(3);
    });

    // Sender received the exact phone/message pairs in order.
    expect(vi.mocked(IMessageSender.send)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(IMessageSender.send)).toHaveBeenNthCalledWith(1, {
      to: '+15555551212',
      message: 'first',
    });
    expect(vi.mocked(IMessageSender.send)).toHaveBeenNthCalledWith(2, {
      to: '+15555559999',
      message: 'second',
    });
    expect(resultCalls()).toHaveLength(2);
    expect(resultCalls().map((call) => JSON.parse(call.body ?? '{}'))).toEqual([
      { claim_token: 'claim-msg-1', success: true },
      { claim_token: 'claim-msg-2', success: true },
    ]);
  });

  it('fetch-capture boundary: exact URL, method GET, Authorization header carries session token', async () => {
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');

    enqueueEmpty();

    IMessageQueueService.start();
    await vi.waitFor(() => expect(popCalls()).toHaveLength(1));

    const call = popCalls()[0];
    expect(call.url).toBe(POP_URL);
    expect(call.method).toBe('GET');
    expect(call.headers['authorization']).toBe('Bearer test-access-token');
    expect(call.headers['x-imessage-delivery-results']).toBe('v1');
    // Pop is a read endpoint — body must be null.
    expect(call.body).toBeNull();
  });

  it('empty state: pop returns {message: null} → exactly one fetch, no send', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');

    enqueueEmpty();

    IMessageQueueService.start();
    await vi.waitFor(() => expect(popCalls()).toHaveLength(1));

    expect(popCalls()).toHaveLength(1);
    expect(vi.mocked(IMessageSender.send)).not.toHaveBeenCalled();
  });

  it('error state (500): non-2xx pop → no send, loop exits without throwing', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');

    enqueueStatus(500, 'internal');

    IMessageQueueService.start();
    await vi.waitFor(() => expect(popCalls()).toHaveLength(1));

    expect(popCalls()[0].responseStatus).toBe(500);
    expect(vi.mocked(IMessageSender.send)).not.toHaveBeenCalled();
  });

  it('error state (401): unauthorized pop → no send, no crash', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');

    enqueueStatus(401, 'unauthorized');

    IMessageQueueService.start();
    await vi.waitFor(() => expect(popCalls()).toHaveLength(1));

    expect(popCalls()[0].responseStatus).toBe(401);
    expect(vi.mocked(IMessageSender.send)).not.toHaveBeenCalled();
  });

  it('sender failure: failure is reported for retry and queue keeps draining', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');

    // First message's send throws, second succeeds — message is already popped,
    // so the loop continues to the next message rather than retrying.
    vi.mocked(IMessageSender.send)
      .mockRejectedValueOnce(new Error('osascript timeout'))
      .mockResolvedValueOnce(undefined);

    enqueueMessage({ id: 'msg-1', phone_number: '+15551111111', message: 'boom' });
    enqueueMessage({ id: 'msg-2', phone_number: '+15552222222', message: 'ok' });
    enqueueEmpty();

    IMessageQueueService.start();
    await vi.waitFor(() => expect(popCalls()).toHaveLength(3));

    expect(vi.mocked(IMessageSender.send)).toHaveBeenCalledTimes(2);
    expect(resultCalls()).toHaveLength(2);
    expect(JSON.parse(resultCalls()[0].body ?? '{}')).toEqual({
      claim_token: 'claim-msg-1',
      success: false,
      error: 'osascript timeout',
    });
    expect(JSON.parse(resultCalls()[1].body ?? '{}')).toEqual({
      claim_token: 'claim-msg-2',
      success: true,
    });
  });

  it('send succeeded but ACK failed: next lease retries ACK without sending again', async () => {
    const { IMessageSender } = await import('../../main/services/iMessageSender');
    const { drainQueue } = await import('../../main/domains/i-message-queue-service/service');

    resultQueue.push(
      new Response('backend unavailable', { status: 503, statusText: 'Unavailable' }),
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    enqueueMessage({ id: 'ack-loss', claim_token: 'claim-first' });
    enqueueEmpty();
    await drainQueue();

    expect(vi.mocked(IMessageSender.send)).toHaveBeenCalledTimes(1);
    expect(resultCalls()).toHaveLength(1);

    enqueueMessage({ id: 'ack-loss', claim_token: 'claim-second' });
    enqueueEmpty();
    await drainQueue();

    expect(vi.mocked(IMessageSender.send)).toHaveBeenCalledTimes(1);
    expect(resultCalls()).toHaveLength(2);
    expect(resultCalls().map((call) => JSON.parse(call.body ?? '{}'))).toEqual([
      { claim_token: 'claim-first', success: true },
      { claim_token: 'claim-second', success: true },
    ]);
  });

  it('idempotent start: calling start() twice does not duplicate polling intervals', async () => {
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');

    enqueueEmpty();
    IMessageQueueService.start();
    await vi.waitFor(() => expect(popCalls()).toHaveLength(1));

    // Second start must be a no-op (service already active). No additional
    // immediate fetch is issued on a duplicate start call.
    const callsBefore = popCalls().length;
    IMessageQueueService.start();
    await new Promise((r) => setImmediate(r));
    expect(popCalls()).toHaveLength(callsBefore);

    expect(IMessageQueueService.isActive()).toBe(true);
  });

  it('stop: clears interval and isActive returns false; stop is idempotent', async () => {
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');

    enqueueEmpty();
    IMessageQueueService.start();
    expect(IMessageQueueService.isActive()).toBe(true);

    IMessageQueueService.stop();
    expect(IMessageQueueService.isActive()).toBe(false);

    // Double-stop is safe.
    IMessageQueueService.stop();
    expect(IMessageQueueService.isActive()).toBe(false);
  });

  it('isActive: reflects pre-start/post-start/post-stop state transitions', async () => {
    const { IMessageQueueService } = await import('../../main/services/IMessageQueueService');

    expect(IMessageQueueService.isActive()).toBe(false);

    enqueueEmpty();
    IMessageQueueService.start();
    expect(IMessageQueueService.isActive()).toBe(true);

    IMessageQueueService.stop();
    expect(IMessageQueueService.isActive()).toBe(false);
  });
});
