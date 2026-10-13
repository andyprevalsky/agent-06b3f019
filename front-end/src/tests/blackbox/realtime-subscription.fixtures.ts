import { vi } from 'vitest';
import type { RealtimeSubscriptionDeps } from '@/features/agent-context/hooks/useRealtimeSubscription';

/** Minimal ACTIVE agent-detail payload for MSW agent-detail responses. */
export function agentDetailJson(messages: Array<Record<string, unknown>>) {
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

export const API_BASE = 'http://localhost:3001/api';
export function mockSession() {
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

export function fakeChannel(state: 'joined' | 'closed' | 'errored' = 'joined') {
  return {
    state,
    topic: 'test',
  } as unknown as import('@supabase/supabase-js').RealtimeChannel;
}

export function makeDeps(
  overrides: Partial<RealtimeSubscriptionDeps> = {},
): RealtimeSubscriptionDeps {
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
    selectedAgentIdRef: { current: 'agent-1' as string | null },
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
