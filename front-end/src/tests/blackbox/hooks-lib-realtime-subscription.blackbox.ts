import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from './msw/server';
import {
  agentDetailJson,
  API_BASE,
  fakeChannel,
  makeDeps,
  mockSession,
} from './realtime-subscription.fixtures';

vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return {
    ...mod,
    subscribeToAgent: vi.fn(),
    unsubscribe: vi.fn(),
  };
});

import {
  useRealtimeSubscription,
  type RealtimeSubscriptionDeps,
} from '@/features/agent-context/hooks/useRealtimeSubscription';
import { DISCONNECTED_BACKFILL_POLL_MS } from '@/features/agent-context/config';
import * as RealtimeMod from '@/lib/realtime';
import { getBrowserSessionBinding } from '@/lib/browserSessionBindings';
import { clearCodeResources, getCodeResources } from '@/lib/codeResources';

type AgentHandlers = Parameters<typeof RealtimeMod.subscribeToAgent>[1];
type CapturedAgentHandlers = Omit<AgentHandlers, 'onAgentModeStarted'> & {
  onAgentModeStarted?: (payload: { agentId: string }) => void;
};

describe('useRealtimeSubscription', () => {
  beforeEach(() => {
    vi.mocked(RealtimeMod.subscribeToAgent).mockReset();
    vi.mocked(RealtimeMod.unsubscribe).mockReset();
    server.use(
      http.get(
        `${API_BASE}/benchmarks/agent-preview/:agentId`,
        () => new HttpResponse(null, { status: 404 }),
      ),
    );
  });

  it('no-ops and cleans up when selectedAgentId is null', () => {
    const deps = makeDeps({ selectedAgentId: null });
    const { unmount } = renderHook(() => useRealtimeSubscription(deps as never));
    expect(RealtimeMod.subscribeToAgent).not.toHaveBeenCalled();
    unmount();
  });

  it('no-ops when canSubscribe is false', () => {
    const deps = makeDeps({ canSubscribe: false });
    const { unmount } = renderHook(() => useRealtimeSubscription(deps as never));
    expect(RealtimeMod.subscribeToAgent).not.toHaveBeenCalled();
    unmount();
  });

  it('subscribes and attaches handlers; cleans up on unmount', async () => {
    let capturedHandlers: CapturedAgentHandlers = {};
    const channel = fakeChannel();
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, h) => {
      capturedHandlers = h as CapturedAgentHandlers;
      return channel;
    });
    const deps = makeDeps();
    const { unmount } = renderHook(() => useRealtimeSubscription(deps));

    await waitFor(() => expect(RealtimeMod.subscribeToAgent).toHaveBeenCalled());
    expect(deps.channelRef.current).toBe(channel);

    // Drive each handler branch once
    capturedHandlers.onInsert?.({
      agentId: 'agent-1',
      id: 'm',
      timestamp: 't',
      text: 'x',
      role: 'USER',
    });
    capturedHandlers.onUpdate?.({ progress: 0.5 });
    capturedHandlers.onAssistantStream?.({
      agentId: 'agent-1',
      stream_id: 's',
      sequence: 0,
      delta: 'x',
      done: false,
    });
    capturedHandlers.onPlanStream?.({
      agentId: 'agent-1',
      stream_id: 's',
      tool_call_id: 'tc',
      title: 't',
    });
    capturedHandlers.onAttentionStream?.({
      agentId: 'agent-1',
      stream_id: 's',
      tool_call_id: 'tc',
      message: 'm',
      is_question: false,
      done: false,
      sequence: 0,
    });
    capturedHandlers.onToolStream?.({
      agentId: 'agent-1',
      stream_id: 's',
      tool_call_id: 'tc',
      tool_name: 'n',
      title: 't',
    });
    capturedHandlers.onAgentModeStarted?.({ agentId: 'agent-1' });
    capturedHandlers.onAgentModeStarted?.({ agentId: 'other' });

    expect(deps.setIsChatMode).toHaveBeenCalled();

    unmount();
    expect(RealtimeMod.unsubscribe).toHaveBeenCalled();
  });

  it('leaves chat mode as soon as the routed cloud-agent message arrives', async () => {
    let capturedHandlers: CapturedAgentHandlers = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, handlers) => {
      capturedHandlers = handlers as CapturedAgentHandlers;
      return fakeChannel();
    });
    let isChatMode = true;
    const deps = makeDeps({
      setIsChatMode: vi.fn((action) => {
        isChatMode = typeof action === 'function' ? action(isChatMode) : action;
      }),
    });
    const { unmount } = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(RealtimeMod.subscribeToAgent).toHaveBeenCalled());

    act(() => {
      capturedHandlers.onInsert?.({
        agentId: 'agent-1',
        id: 'cloud-agent-route',
        timestamp: new Date().toISOString(),
        text: '',
        role: 'TOOL',
        metadata: {
          toolCallId: 'cloud-agent-call',
          toolName: 'cloud_agent',
          toolStatus: 'IN_PROGRESS',
          startPhase: 'plan',
        },
      });
    });

    expect(isChatMode).toBe(false);
    unmount();
  });

  it('publishes BROWSER_SESSION rebinds to the live-view binding store', async () => {
    let capturedHandlers: CapturedAgentHandlers = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, handlers) => {
      capturedHandlers = handlers as CapturedAgentHandlers;
      return fakeChannel();
    });
    const { unmount } = renderHook(() => useRealtimeSubscription(makeDeps()));
    await waitFor(() => expect(RealtimeMod.subscribeToAgent).toHaveBeenCalled());

    const promoted = {
      agentId: 'agent-1',
      taskId: 'task-promoted',
      sessionId: 'kernel-winner',
      debugUrl:
        'https://prod-iad-hypeman-28.kernel.sh:8443/browser/live/pmHw1BNYtFaS?readOnly=true',
      status: 'ACTIVE',
      live: true,
      asOf: 2,
    };
    act(() => capturedHandlers.onBrowserSession?.(promoted));

    expect(getBrowserSessionBinding('task-promoted')).toEqual({
      taskId: 'task-promoted',
      sessionId: 'kernel-winner',
      debugUrl: promoted.debugUrl,
      status: 'ACTIVE',
      live: true,
      asOf: 2,
    });
    unmount();
  });

  it('publishes CODE_RESOURCES samples to the code-resources store while the scope is active', async () => {
    clearCodeResources();
    let capturedHandlers: CapturedAgentHandlers = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, handlers) => {
      capturedHandlers = handlers as CapturedAgentHandlers;
      return fakeChannel();
    });
    const { unmount } = renderHook(() => useRealtimeSubscription(makeDeps()));
    await waitFor(() => expect(RealtimeMod.subscribeToAgent).toHaveBeenCalled());

    const resources = {
      sampled_at: '2026-10-26T18:02:15.000Z',
      cpu: { used_pct: 36, cores: 8 },
      memory: { used_bytes: 11, total_bytes: 16 },
      disk: null,
    };
    act(() => capturedHandlers.onCodeResources?.({ taskId: 'task-res', resources }));
    expect(getCodeResources('task-res')).toEqual(resources);

    unmount();
    const late = { ...resources, sampled_at: '2026-10-26T18:04:15.000Z' };
    act(() => capturedHandlers.onCodeResources?.({ taskId: 'task-res', resources: late }));
    expect(getCodeResources('task-res')).toEqual(resources);
  });

  it('restores chat mode when the root completion_summary finishes', async () => {
    let capturedHandlers: CapturedAgentHandlers = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, handlers) => {
      capturedHandlers = handlers as CapturedAgentHandlers;
      return fakeChannel();
    });
    let isChatMode = false;
    const deps = makeDeps({
      setIsChatMode: vi.fn((action) => {
        isChatMode = typeof action === 'function' ? action(isChatMode) : action;
      }),
    });
    const { unmount } = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(RealtimeMod.subscribeToAgent).toHaveBeenCalled());

    act(() => {
      capturedHandlers.onInsert?.({
        agentId: 'agent-1',
        id: 'completion-summary',
        timestamp: new Date().toISOString(),
        text: '',
        role: 'TOOL',
        metadata: {
          toolCallId: 'c170f05c-1dbf-474a-b727-34442ac7ff94',
          toolName: 'completion_summary',
          toolStatus: 'FINISHED',
          isFinalSummary: true,
        },
      });
    });

    expect(isChatMode).toBe(true);
    unmount();
  });

  it('does not restore chat mode from a child completion_summary', async () => {
    let capturedHandlers: CapturedAgentHandlers = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, handlers) => {
      capturedHandlers = handlers as CapturedAgentHandlers;
      return fakeChannel();
    });
    let isChatMode = false;
    const deps = makeDeps({
      setIsChatMode: vi.fn((action) => {
        isChatMode = typeof action === 'function' ? action(isChatMode) : action;
      }),
    });
    const { unmount } = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(RealtimeMod.subscribeToAgent).toHaveBeenCalled());

    act(() => {
      capturedHandlers.onInsert?.({
        agentId: 'agent-1',
        id: 'child-completion-summary',
        timestamp: new Date().toISOString(),
        text: '',
        role: 'TOOL',
        metadata: {
          toolCallId: 'child-summary',
          toolName: 'completion_summary',
          toolStatus: 'FINISHED',
          isFinalSummary: true,
          subAgentId: 'child-agent',
        },
      });
    });

    expect(isChatMode).toBe(false);
    unmount();
  });

  it('rejects an A update queued before switching when its React updater commits after B', async () => {
    let capturedHandlers: CapturedAgentHandlers = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, handlers) => {
      capturedHandlers = handlers as CapturedAgentHandlers;
      return fakeChannel();
    });
    const deps = makeDeps();
    const { unmount } = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(RealtimeMod.subscribeToAgent).toHaveBeenCalled());
    vi.mocked(deps.setAgent).mockClear();

    capturedHandlers.onUpdate?.({ title: 'late title from A' });
    const queuedUpdater = vi.mocked(deps.setAgent).mock.calls[0]?.[0];
    expect(typeof queuedUpdater).toBe('function');
    deps.selectedAgentIdRef.current = 'agent-2';
    const agentB = { agent_id: 'agent-2', title: 'title for B' } as never;

    expect((queuedUpdater as (agent: typeof agentB) => typeof agentB)(agentB)).toBe(agentB);
    unmount();
  });

  it('onDisconnect schedules a reconnect (increments attempt ref)', async () => {
    let capturedHandlers: CapturedAgentHandlers = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, h) => {
      capturedHandlers = h as CapturedAgentHandlers;
      return fakeChannel();
    });
    const deps = makeDeps();
    renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(capturedHandlers).toBeTruthy());

    const before = deps.reconnectAttemptRef.current;
    act(() => {
      capturedHandlers.onDisconnect?.();
    });
    expect(deps.reconnectAttemptRef.current).toBeGreaterThan(before);
  });

  // Regression: vitest can tear down jsdom while a reconnect timer is still
  // queued; setState after window is gone becomes an unhandled ReferenceError
  // and fails the whole coverage run even when every test assertion passed.
  it('reconnect timeout no-ops when window is gone', async () => {
    let capturedHandlers: CapturedAgentHandlers = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, h) => {
      capturedHandlers = h as CapturedAgentHandlers;
      return fakeChannel();
    });
    const deps = makeDeps();
    const { unmount } = renderHook(() => useRealtimeSubscription(deps));
    await waitFor(() => expect(capturedHandlers.onDisconnect).toBeTypeOf('function'));

    let reconnectCb: (() => void) | null = null;
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
      ...args: unknown[]
    ) => {
      if (typeof handler === 'function' && timeout === 0 && reconnectCb === null) {
        reconnectCb = handler as () => void;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(handler as never, timeout as never, ...(args as never[]));
    }) as typeof setTimeout);

    act(() => {
      capturedHandlers.onDisconnect?.();
    });
    expect(reconnectCb).toBeTypeOf('function');

    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: undefined,
    });
    try {
      expect(() => reconnectCb?.()).not.toThrow();
      expect(deps.setForceResubscribeCounter).not.toHaveBeenCalled();
    } finally {
      if (windowDescriptor) {
        Object.defineProperty(globalThis, 'window', windowDescriptor);
      }
      setTimeoutSpy.mockRestore();
      unmount();
    }
  });

  it('on subscribe failure, logs error and schedules reconnect', async () => {
    vi.mocked(RealtimeMod.subscribeToAgent).mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps();
    renderHook(() => useRealtimeSubscription(deps as never));
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(deps.reconnectAttemptRef.current).toBeGreaterThan(0);
    errSpy.mockRestore();
  });

  it('does not schedule reconnect when subscribe rejects after unmount', async () => {
    let rejectSubscription!: (error: Error) => void;
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectSubscription = reject;
        }),
    );
    const deps = makeDeps();
    const { unmount } = renderHook(() => useRealtimeSubscription(deps));
    expect(RealtimeMod.subscribeToAgent).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => {
      rejectSubscription(new Error('late subscribe failure'));
      await Promise.resolve();
    });

    expect(deps.reconnectAttemptRef.current).toBe(0);
    expect(deps.reconnectTimeoutRef.current).toBeNull();
    expect(deps.setForceResubscribeCounter).not.toHaveBeenCalled();
  });

  it('unsubscribes a channel whose subscription resolves after unmount', async () => {
    let finishSubscription!: (channel: ReturnType<typeof fakeChannel>) => void;
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSubscription = resolve;
        }),
    );
    const deps = makeDeps();
    const { unmount } = renderHook(() => useRealtimeSubscription(deps));
    const lateChannel = fakeChannel();

    unmount();
    await act(async () => {
      finishSubscription(lateChannel);
      await Promise.resolve();
    });

    expect(RealtimeMod.unsubscribe).toHaveBeenCalledWith(lateChannel);
    expect(deps.channelRef.current).toBeNull();
  });

  it('drops a connected backfill response after switching agents', async () => {
    let finishRequest!: () => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const requestCanFinish = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, async () => {
        markRequestStarted();
        await requestCanFinish;
        return HttpResponse.json(agentDetailJson([]));
      }),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockResolvedValue(fakeChannel());
    mockSession();
    const deps = makeDeps();
    const { unmount } = renderHook(() => useRealtimeSubscription(deps));
    await requestStarted;

    deps.selectedAgentIdRef.current = 'agent-2';
    finishRequest();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deps.setMessages).not.toHaveBeenCalled();
    expect(deps.setAgent).not.toHaveBeenCalled();
    unmount();
  });

  it('drops a disconnected poll response after switching agents', async () => {
    let finishRequest!: () => void;
    let markRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const requestCanFinish = new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, async () => {
        markRequestStarted();
        await requestCanFinish;
        return HttpResponse.json(agentDetailJson([]));
      }),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(() => new Promise(() => {}));
    mockSession();
    const deps = makeDeps();
    vi.useFakeTimers();
    const { unmount } = renderHook(() => useRealtimeSubscription(deps));
    try {
      await vi.advanceTimersByTimeAsync(DISCONNECTED_BACKFILL_POLL_MS + 1);
      await requestStarted;
      deps.selectedAgentIdRef.current = 'agent-2';
      finishRequest();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(deps.setMessages).not.toHaveBeenCalled();
      expect(deps.setAgent).not.toHaveBeenCalled();
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('reconnection refetches agent detail and merges messages', async () => {
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, () =>
        HttpResponse.json({
          agent: {
            agent_id: 'agent-1',
            goal: 'g',
            model: 'm',
            source: 'WEB',
            reasoning_effort: 'off',
            progress: 0.5,
            status: 'ACTIVE',
            status_message: null,
            temporal_workflow_id: 'wf',
            token_count: 0,
            tokens_in: 0,
            tokens_out: 0,
            tool_tokens_in: 0,
            tool_tokens_out: 0,
            tool_cost_cents: 0,
            context_size: 0,
            message_count: 0,
            price_limit_cents: 100,
            tree_cost_cents: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            write_lock_enabled: false,
            verifier: null,
            tools: [],
          },
          messages: [{ message_id: 'from-api', timestamp: 't', text: '', role: 'USER' }],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockResolvedValue(fakeChannel());
    const deps = makeDeps({
      forceResubscribeCounter: 1,
      initialLoadDoneRef: { current: 'agent-1' },
    });
    mockSession();
    renderHook(() => useRealtimeSubscription(deps as never));
    await waitFor(() => expect(deps.setMessages).toHaveBeenCalled());
    // Re-fetch also triggers agent setter
    expect(deps.setAgent).toHaveBeenCalled();
  });

  // Regression (RCA 2026-07-17): the prod chat-lifecycle gate stayed red even
  // with the reconnect backfill because a BRAND-NEW agent's first subscribe is a
  // COLD START (initialLoadDoneRef !== agentId, forceResubscribeCounter === 0),
  // not a reconnection — so the gated backfill never fired. The stream produced
  // during the ~1-2s subscribe/auth-race window was missed and never replayed, so
  // the answer sat stranded in the DB. Every successful (re)subscribe must now
  // reconcile from the API, cold start included.
  it('backfills on a cold-start first subscribe (new agent, not a reconnection)', async () => {
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, () =>
        HttpResponse.json({
          agent: {
            agent_id: 'agent-1',
            goal: 'g',
            model: 'm',
            source: 'WEB',
            reasoning_effort: 'off',
            progress: 1,
            status: 'COMPLETED',
            status_message: null,
            temporal_workflow_id: null,
            token_count: 0,
            tokens_in: 0,
            tokens_out: 0,
            tool_tokens_in: 0,
            tool_tokens_out: 0,
            tool_cost_cents: 0,
            context_size: 0,
            message_count: 1,
            price_limit_cents: 100,
            tree_cost_cents: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            write_lock_enabled: false,
            verifier: null,
            tools: [],
          },
          messages: [{ message_id: 'answer', timestamp: 't', text: 'ANSWER', role: 'ASSISTANT' }],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    vi.mocked(RealtimeMod.subscribeToAgent).mockResolvedValue(fakeChannel());
    const deps = makeDeps({
      forceResubscribeCounter: 0,
      initialLoadDoneRef: { current: null as string | null },
    });
    mockSession();
    renderHook(() => useRealtimeSubscription(deps as never));
    // The stranded answer must be reconciled from the API on the cold-start join.
    await waitFor(() => expect(deps.setMessages).toHaveBeenCalled());
    expect(deps.setAgent).toHaveBeenCalled();
  });

  // Regression: prod chat stalled on "Thinking" because the agent:<id> private
  // channel join was rejected Unauthorized for ~43s (auth race right after
  // creation) and realtime never replays missed broadcasts. The disconnected
  // backfill poll must reconcile from the API so the answer surfaces even though
  // the channel never connects. Before the fix (no poll) setMessages was never
  // called while the channel stayed down, and the message never appeared.
  it('backfills via API poll while the agent channel never connects (auth race)', async () => {
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, () =>
        HttpResponse.json(
          agentDetailJson([
            { message_id: 'answer-from-api', timestamp: 't', text: 'BROWSERPROBE7', role: 'TOOL' },
          ]),
        ),
      ),
    );
    // The private-channel join is rejected (Unauthorized) and never connects, so
    // channelRef stays null and realtime delivers nothing.
    vi.mocked(RealtimeMod.subscribeToAgent).mockRejectedValue(
      new Error('Channel error for agent:agent-1: Unauthorized'),
    );
    mockSession();
    const deps = makeDeps();
    vi.useFakeTimers();
    try {
      renderHook(() => useRealtimeSubscription(deps as never));
      await vi.advanceTimersByTimeAsync(DISCONNECTED_BACKFILL_POLL_MS + 250);
    } finally {
      vi.useRealTimers();
    }
    expect(deps.channelRef.current).toBeNull();
    expect(deps.setMessages).toHaveBeenCalled();
    expect(deps.setAgent).toHaveBeenCalled();
  });

  // Regression (CodeRabbit PR #783): once the channel is live, channelRef.current
  // is set, so the disconnected fallback poll skips every tick. A SINGLE transient
  // failure of the post-subscribe reconcile fetch would therefore strand the
  // auth-race messages until an unrelated resubscribe. The bounded retry must
  // recover: fetchAgentDetail 500s once, then succeeds, and the backfill lands
  // (setMessages called + agent marked reconciled) without any resubscribe.
  it('retries a transiently failing post-subscribe backfill while the channel is live', async () => {
    let calls = 0;
    server.use(
      http.get(`${API_BASE}/agents/agent-1`, () => {
        calls += 1;
        if (calls === 1) return new HttpResponse(null, { status: 500 });
        return HttpResponse.json(
          agentDetailJson([
            { message_id: 'answer', timestamp: 't', text: 'RECOVERED', role: 'ASSISTANT' },
          ]),
        );
      }),
    );
    // Channel joins successfully → channelRef is set → the disconnected poll is a
    // no-op, so ONLY the post-subscribe retry loop can recover the first 500.
    vi.mocked(RealtimeMod.subscribeToAgent).mockResolvedValue(fakeChannel());
    mockSession();
    const deps = makeDeps({
      forceResubscribeCounter: 0,
      initialLoadDoneRef: { current: null as string | null },
    });
    renderHook(() => useRealtimeSubscription(deps as never));
    await waitFor(() => expect(deps.setMessages).toHaveBeenCalled(), { timeout: 3000 });
    expect(calls).toBeGreaterThanOrEqual(2);
    // Reconciled flag only flips AFTER a successful backfill, never on the 500.
    expect(deps.initialLoadDoneRef.current).toBe('agent-1');
  });
});
