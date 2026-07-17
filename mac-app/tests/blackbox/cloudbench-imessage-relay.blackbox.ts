import { describe, expect, it, vi } from 'vitest';
import {
  isUsableSession,
  relayAuthHeaders,
  resolveRelaySession,
  runRelay,
  sessionExpiresAtMs,
  type RelayDependencies,
  type RelayMarkerStore,
  type RelayOutcome,
  type RelayQueueMessage,
} from '../../scripts/cloudbench-imessage-relay';

const USER = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const farFuture = () => Math.floor(Date.now() / 1000) + 3600;

describe('installed-session usability (drives relay auto-login)', () => {
  it('uses an explicitly scoped internal identity for cloud benchmark relays', () => {
    expect(relayAuthHeaders(USER, 'benchmark-api-key')).toEqual({
      'X-API-Key': 'benchmark-api-key',
      'X-User-Id': USER,
      'X-CloudBench-iMessage-Relay': 'v1',
    });
  });
  it('accepts a fresh session for the expected user', () => {
    expect(
      isUsableSession({ access_token: 'a', expires_at: farFuture(), user: { id: USER } }, USER)
    ).toBe(true);
  });
  it('rejects when no session / no token (triggers auto-login)', () => {
    expect(isUsableSession(undefined, USER)).toBe(false);
    expect(isUsableSession({ expires_at: farFuture(), user: { id: USER } }, USER)).toBe(false);
  });
  it('rejects a session belonging to a different user', () => {
    expect(
      isUsableSession(
        { access_token: 'a', expires_at: farFuture(), user: { id: 'someone-else' } },
        USER
      )
    ).toBe(false);
  });
  it('rejects an expired / about-to-expire session', () => {
    expect(
      isUsableSession(
        { access_token: 'a', expires_at: Math.floor(Date.now() / 1000) - 10, user: { id: USER } },
        USER
      )
    ).toBe(false);
    expect(
      isUsableSession(
        { access_token: 'a', expires_at: Math.floor(Date.now() / 1000) + 30, user: { id: USER } },
        USER
      )
    ).toBe(false);
  });
  it('normalizes both second- and millisecond-epoch expiries', () => {
    const secs = Math.floor(Date.now() / 1000) + 3600;
    expect(sessionExpiresAtMs({ expires_at: secs })).toBe(secs * 1000);
    expect(sessionExpiresAtMs({ expires_at: secs * 1000 })).toBe(secs * 1000);
    expect(sessionExpiresAtMs(undefined)).toBe(0);
  });

  it('uses benchmark auto-login without overwriting an unreadable installed store', async () => {
    const minted = {
      access_token: 'benchmark-token',
      expires_at: farFuture(),
      user: { id: USER },
    };
    const persist = vi.fn();

    await expect(
      resolveRelaySession(
        USER,
        { phone: '+19729777432', otp: '181818' },
        () => {
          throw new SyntaxError('encrypted store cannot be decoded');
        },
        async () => minted,
        persist
      )
    ).resolves.toEqual(minted);
    expect(persist).not.toHaveBeenCalled();
  });
});

const queuedMessage = (claimToken = 'claim-1'): RelayQueueMessage => ({
  id: 'queue-1',
  phone_number: '+19729777432',
  message: 'Hi! This is the Rose iMessage send bench.',
  agent_id: 'agent-1',
  created_at: '2026-07-13T00:00:00.000Z',
  claim_token: claimToken,
});

function success<T>(data?: T): RelayOutcome<T> {
  return { ok: true, status: 200, statusText: 'OK', data };
}

function harness(popResults: RelayOutcome<{ message: RelayQueueMessage | null }>[]) {
  let now = 0;
  const sentMarkers = new Set<string>();
  const markers: RelayMarkerStore = {
    has: vi.fn((id) => sentMarkers.has(id)),
    mark: vi.fn((id) => sentMarkers.add(id)),
    clear: vi.fn((id) => sentMarkers.delete(id)),
  };
  const dependencies: RelayDependencies = {
    pop: vi.fn(async () => popResults.shift() ?? success({ message: null })),
    report: vi.fn(async () => success()),
    send: vi.fn(async () => undefined),
    markers,
    now: () => now,
    sleep: vi.fn(async (milliseconds) => {
      now += milliseconds;
    }),
    log: vi.fn(),
  };
  return { dependencies, markers };
}

const config = {
  expectedPhone: '+19729777432',
  expectedMessage: 'Hi! This is the Rose iMessage send bench.',
  timeoutMs: 10_000,
  pollIntervalMs: 100,
};

describe('cloudbench iMessage relay', () => {
  it('establishes a heartbeat, sends the exact message, and ACKs durably', async () => {
    const { dependencies, markers } = harness([
      success({ message: null }),
      success({ message: queuedMessage() }),
    ]);

    await expect(runRelay(config, dependencies)).resolves.toEqual({
      queueId: 'queue-1',
      agentId: 'agent-1',
      phoneNumber: '+19729777432',
    });
    expect(dependencies.send).toHaveBeenCalledTimes(1);
    expect(dependencies.report).toHaveBeenCalledWith('queue-1', {
      claim_token: 'claim-1',
      success: true,
    });
    expect(markers.mark).toHaveBeenCalledWith('queue-1');
    expect(markers.clear).toHaveBeenCalledWith('queue-1');
    expect(dependencies.log).toHaveBeenCalledWith('bridge heartbeat established');
  });

  it('never runs AppleScript twice when an ACK is lost and the item is reclaimed', async () => {
    const { dependencies, markers } = harness([
      success({ message: queuedMessage('claim-1') }),
      success({ message: queuedMessage('claim-2') }),
    ]);
    vi.mocked(dependencies.report)
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable' })
      .mockResolvedValueOnce(success());

    await runRelay(config, dependencies);

    expect(dependencies.send).toHaveBeenCalledTimes(1);
    expect(dependencies.report).toHaveBeenNthCalledWith(1, 'queue-1', {
      claim_token: 'claim-1',
      success: true,
    });
    expect(dependencies.report).toHaveBeenNthCalledWith(2, 'queue-1', {
      claim_token: 'claim-2',
      success: true,
    });
    expect(markers.clear).toHaveBeenCalledTimes(1);
  });

  it('fails closed and reports a mismatched queue item without sending it', async () => {
    const unexpected = { ...queuedMessage(), message: 'unrelated user message' };
    const { dependencies } = harness([success({ message: unexpected })]);

    await expect(runRelay(config, dependencies)).rejects.toThrow('Refusing unexpected queue item');
    expect(dependencies.send).not.toHaveBeenCalled();
    expect(dependencies.report).toHaveBeenCalledWith(
      'queue-1',
      expect.objectContaining({ claim_token: 'claim-1', success: false })
    );
  });

  it('reports AppleScript failures and retries only after the backend requeues', async () => {
    const { dependencies } = harness([
      success({ message: queuedMessage('claim-1') }),
      success({ message: queuedMessage('claim-2') }),
    ]);
    vi.mocked(dependencies.send)
      .mockRejectedValueOnce(new Error('Messages unavailable'))
      .mockResolvedValueOnce(undefined);

    await runRelay(config, dependencies);

    expect(dependencies.send).toHaveBeenCalledTimes(2);
    expect(dependencies.report).toHaveBeenNthCalledWith(1, 'queue-1', {
      claim_token: 'claim-1',
      success: false,
      error: 'Messages unavailable',
    });
    expect(dependencies.report).toHaveBeenNthCalledWith(2, 'queue-1', {
      claim_token: 'claim-2',
      success: true,
    });
  });

  it('times out instead of claiming success from heartbeats alone', async () => {
    const { dependencies } = harness([]);

    await expect(runRelay({ ...config, timeoutMs: 250 }, dependencies)).rejects.toThrow(
      'Timed out waiting for confirmed benchmark iMessage'
    );
    expect(dependencies.send).not.toHaveBeenCalled();
  });
});
