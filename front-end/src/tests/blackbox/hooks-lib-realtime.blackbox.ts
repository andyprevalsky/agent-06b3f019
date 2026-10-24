import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { supabase } from '@/lib/supabase';

function mockSession() {
  const session = {
    access_token:
      'eyJhbGciOiJIUzI1NiJ9.' +
      btoa(JSON.stringify({ sub: 'user-12345678', role: 'authenticated' })) +
      '.signature-signature-signature',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'user-12345678', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  return session;
}

describe('lib/realtime', () => {
  // IMPORTANT: These tests use the REAL subscribeToAgent/subscribeToBus from
  // the module we mocked above. The mock replaces subscribeToAgent/Bus with
  // vi.fn() shims in other test blocks — here we explicitly use the
  // `importOriginal` copy indirectly. Because vi.mock affects only the
  // specific import surface, we re-import the real implementations via a
  // dynamic import from the sibling module file.
  let real: typeof import('@/lib/realtime');
  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('@/lib/realtime')>('@/lib/realtime');
    real = actual;
  });

  beforeEach(() => {
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
  });

  function setupChannelStub(statuses: string[] = ['SUBSCRIBED']) {
    // Patch supabase.channel + supabase.removeChannel for the duration
    // of the test via module spying.
    const listeners: Array<(status: string) => void> = [];
    const channel = {
      on: vi.fn(),
      subscribe: vi.fn(),
    };
    channel.on.mockReturnValue(channel);
    channel.subscribe.mockImplementation((cb: (s: string) => void) => {
      listeners.push(cb);
      for (const status of statuses) cb(status);
      return channel;
    });
    const chanSpy = vi.spyOn(supabase, 'channel').mockReturnValue(channel as never);
    const rmSpy = vi.spyOn(supabase, 'removeChannel').mockReturnValue('ok' as never);
    const authSpy = vi.spyOn(supabase.realtime, 'setAuth').mockResolvedValue(undefined as never);
    return { channel, chanSpy, rmSpy, authSpy, listeners };
  }

  it('subscribeToAgent: throws when no session', async () => {
    localStorage.clear();
    await expect(real.subscribeToAgent('a-1', {})).rejects.toThrow('Not authenticated');
  });

  it('subscribeToAgent: resolves on SUBSCRIBED, attaches handlers; invoking handler wrappers hits extractors', async () => {
    // Collect the (eventName → handler) map by intercepting channel.on
    const stub = setupChannelStub(['SUBSCRIBED']);
    const eventMap: Record<string, (w: unknown) => void> = {};
    stub.channel.on.mockImplementation(
      (_type: string, cfg: { event: string }, handler: (w: unknown) => void) => {
        eventMap[cfg.event] = handler;
        return stub.channel;
      },
    );

    const onInsert = vi.fn();
    const onUpdate = vi.fn();
    const onDelete = vi.fn();
    const onAssistantStream = vi.fn();
    const onPlanStream = vi.fn();
    const onAttentionStream = vi.fn();
    const onToolStream = vi.fn();
    const onAgentModeStarted = vi.fn();
    const onDisconnect = vi.fn();
    const ch = await real.subscribeToAgent('a-1', {
      onInsert,
      onUpdate,
      onDelete,
      onAssistantStream,
      onPlanStream,
      onAttentionStream,
      onToolStream,
      onAgentModeStarted,
      onDisconnect,
    });
    expect(ch).toBe(stub.channel);
    // Fire each wrapper with an invalid payload — extractor returns null → no-op (covers the `if (record)` lines)
    for (const ev of [
      'INSERT',
      'UPDATE',
      'DELETE',
      'ASSISTANT_STREAM',
      'PLAN_STREAM',
      'ATTENTION_STREAM',
      'TOOL_STREAM',
      'AGENT_MODE_STARTED',
    ]) {
      eventMap[ev]?.(undefined);
    }
    // No extractor succeeds on undefined, so none of the user callbacks fired.
    expect(onInsert).not.toHaveBeenCalled();
  });

  it('subscribeToAgent: delivers a valid BROWSER_SESSION binding and drops malformed ones', async () => {
    const stub = setupChannelStub(['SUBSCRIBED']);
    const eventMap: Record<string, (w: unknown) => void> = {};
    stub.channel.on.mockImplementation(
      (_type: string, cfg: { event: string }, handler: (w: unknown) => void) => {
        eventMap[cfg.event] = handler;
        return stub.channel;
      },
    );
    const onBrowserSession = vi.fn();
    await real.subscribeToAgent('a-browser', { onBrowserSession });
    const record = {
      agentId: 'a-browser',
      taskId: 'e264ec23-538b-50bb-9874-30c9830a49d8',
      sessionId: 'qzsodw10re6xto2hd8vcjxps',
      debugUrl:
        'https://prod-iad-hypeman-28.kernel.sh:8443/browser/live/pmHw1BNYtFaS?readOnly=true',
      status: 'ACTIVE',
      live: true,
      asOf: 1791579416000,
    };
    // Backend sendBroadcastBatch wraps every payload as { record }.
    eventMap['BROWSER_SESSION']?.({ payload: { record } });
    eventMap['BROWSER_SESSION']?.({ payload: { record: { ...record, asOf: 'late' } } });
    expect(onBrowserSession).toHaveBeenCalledTimes(1);
    expect(onBrowserSession).toHaveBeenCalledWith(record);
  });

  it('subscribeToAgent: delivers an INSERT_DEFERRED notice and drops malformed ones', async () => {
    const stub = setupChannelStub(['SUBSCRIBED']);
    const eventMap: Record<string, (w: unknown) => void> = {};
    stub.channel.on.mockImplementation(
      (_type: string, cfg: { event: string }, handler: (w: unknown) => void) => {
        eventMap[cfg.event] = handler;
        return stub.channel;
      },
    );
    const onInsertDeferred = vi.fn();
    await real.subscribeToAgent('a-deferred', { onInsertDeferred });
    // Exactly the identifier-only record the backend sends after a 403/4xx.
    const record = { agentId: 'a-deferred', id: '75e5af12-8b66-4b72-b061-3be30ce4308d' };
    eventMap['INSERT_DEFERRED']?.({ payload: { record } });
    eventMap['INSERT_DEFERRED']?.({ payload: { record: { agentId: 'a-deferred', id: '' } } });
    eventMap['INSERT_DEFERRED']?.({ payload: { record: { id: record.id } } });
    expect(onInsertDeferred).toHaveBeenCalledTimes(1);
    expect(onInsertDeferred).toHaveBeenCalledWith(record);
  });

  it('subscribeToAgent: rejects on CHANNEL_ERROR before resolve', async () => {
    setupChannelStub(['CHANNEL_ERROR']);
    await expect(real.subscribeToAgent('a-2', {})).rejects.toThrow(/error/i);
  });

  it('subscribeToAgent: rejects on TIMED_OUT before resolve', async () => {
    setupChannelStub(['TIMED_OUT']);
    await expect(real.subscribeToAgent('a-3', {})).rejects.toThrow(/timed out/i);
  });

  it('subscribeToAgent: rejects on CLOSED before resolve', async () => {
    setupChannelStub(['CLOSED']);
    await expect(real.subscribeToAgent('a-4', {})).rejects.toThrow(/closed/i);
  });

  it('subscribeToAgent: fires onDisconnect after re-join error', async () => {
    const { listeners } = setupChannelStub(['SUBSCRIBED']);
    const onDisconnect = vi.fn();
    await real.subscribeToAgent('a-5', { onDisconnect });
    // Simulate a later post-join disconnect
    listeners[0]('CHANNEL_ERROR');
    expect(onDisconnect).toHaveBeenCalled();
  });

  it('subscribeToBus: attaches AGENT_STATE_CHANGED handler', async () => {
    const stub = setupChannelStub(['SUBSCRIBED']);
    const eventMap: Record<string, (w: unknown) => void> = {};
    stub.channel.on.mockImplementation(
      (_type: string, cfg: { event: string }, handler: (w: unknown) => void) => {
        eventMap[cfg.event] = handler;
        return stub.channel;
      },
    );
    const onAgentStateChanged = vi.fn();
    await real.subscribeToBus('bus-1', { onAgentStateChanged });
    // Invoke wrapper with an invalid payload (extractor null → no-op branch)
    eventMap['AGENT_STATE_CHANGED']?.(undefined);
    expect(onAgentStateChanged).not.toHaveBeenCalled();
  });

  it('subscribeToBus: works without any handlers', async () => {
    setupChannelStub(['SUBSCRIBED']);
    await real.subscribeToBus('bus-2', {});
  });

  it('subscribeToAttentionRequests: attaches INSERT/UPDATE/DELETE handlers', async () => {
    const { channel } = setupChannelStub(['SUBSCRIBED']);
    await real.subscribeToAttentionRequests('user-1', {
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(channel.on).toHaveBeenCalled();
  });

  it('unsubscribe: no-op when given null', () => {
    // Should not throw
    real.unsubscribe(null as never);
  });

  it('unsubscribe: delegates to supabase.removeChannel', () => {
    const { rmSpy } = setupChannelStub(['SUBSCRIBED']);
    real.unsubscribe({} as never);
    expect(rmSpy).toHaveBeenCalled();
  });
});
