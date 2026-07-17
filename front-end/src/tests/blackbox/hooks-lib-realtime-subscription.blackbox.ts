import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from './msw/server';

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

/** Minimal ACTIVE agent-detail payload for MSW agent-detail responses. */
function agentDetailJson(messages: Array<Record<string, unknown>>) {
  return {
    agent: {
      agent_id: 'agent-1',
      goal: 'g',
      model: 'm',
      source: 'WEB',
      reasoning_effort: 'off',
      progress: 0.5,
      status: 'ACTIVE',
      status_message: null,
      temporal_workflow_id: null,
      token_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      tool_tokens_in: 0,
      tool_tokens_out: 0,
      tool_cost_cents: 0,
      context_size: 0,
      message_count: messages.length,
      price_limit_cents: 100,
      tree_cost_cents: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      write_lock_enabled: false,
      verifier: null,
      tools: [],
    },
    messages,
    pagination: { has_more: false, oldest_timestamp: null },
  };
}

const API_BASE = 'http://localhost:3001/api';
type AgentHandlers = Parameters<typeof RealtimeMod.subscribeToAgent>[1];
type CapturedAgentHandlers = Omit<AgentHandlers, 'onAgentModeStarted'> & {
  onAgentModeStarted?: (payload: { agentId: string }) => void;
};

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

function fakeChannel(state: 'joined' | 'closed' | 'errored' = 'joined') {
  return {
    state,
    topic: 'test',
  } as unknown as import('@supabase/supabase-js').RealtimeChannel;
}

describe('useRealtimeSubscription', () => {
  function makeDeps(overrides: Partial<RealtimeSubscriptionDeps> = {}): RealtimeSubscriptionDeps {
    const setters = {
      setStreamingBubbles: vi.fn(),
      setStreamingPlan: vi.fn(),
      setStreamingAttention: vi.fn(),
      setStreamingTools: vi.fn(),
      setMessages: vi.fn(),
      setAgent: vi.fn(),
      setIsChatMode: vi.fn(),
      setForceResubscribeCounter: vi.fn(),
      dispatchMessage: vi.fn(),
    };
    const refs = {
      channelRef: { current: null as never },
      reconnectAttemptRef: { current: 0 },
      reconnectTimeoutRef: { current: null as number | null },
      isReconnectingRef: { current: false },
      initialLoadDoneRef: { current: null as string | null },
      streamedTextsRef: { current: new Set<string>() },
      completedStreamIdsRef: { current: new Set<string>() },
    };
    return {
      ...setters,
      ...refs,
      selectedAgentId: 'agent-1',
      canSubscribe: true,
      forceResubscribeCounter: 0,
      onLoadAgents: vi.fn(),
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.mocked(RealtimeMod.subscribeToAgent).mockReset();
    vi.mocked(RealtimeMod.unsubscribe).mockReset();
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

    expect(deps.setIsChatMode).toHaveBeenCalledWith(false);

    unmount();
    expect(RealtimeMod.unsubscribe).toHaveBeenCalled();
  });

  it('leaves chat mode as soon as the routed cloud-agent message arrives', async () => {
    let capturedHandlers: CapturedAgentHandlers = {};
    vi.mocked(RealtimeMod.subscribeToAgent).mockImplementation(async (_, handlers) => {
      capturedHandlers = handlers as CapturedAgentHandlers;
      return fakeChannel();
    });
    const deps = makeDeps();
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

    expect(deps.setIsChatMode).toHaveBeenCalledWith(false);
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

  it('on subscribe failure, logs error and schedules reconnect', async () => {
    vi.mocked(RealtimeMod.subscribeToAgent).mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps();
    renderHook(() => useRealtimeSubscription(deps as never));
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(deps.reconnectAttemptRef.current).toBeGreaterThan(0);
    errSpy.mockRestore();
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
});
