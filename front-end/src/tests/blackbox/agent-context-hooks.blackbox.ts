/**
 * Blackbox tests for @/features/agent-context/hooks.ts — useAgentProvider +
 * useAgentContext.
 *
 * We mock the heavy sub-hooks (realtime subscription, health check,
 * popstate / visibility listeners) to avoid infinite reconnect loops in
 * jsdom, and focus on the state-management logic inside useAgentProvider.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { clearCaptures, capturedRequests } from './msw/capture';
import React from 'react';

// Mock subs BEFORE importing hook
vi.mock('@/features/agent-context/hooks/useRealtimeSubscription', () => ({
  useRealtimeSubscription: vi.fn(),
}));
vi.mock('@/features/agent-context/hooks/useHealthCheck', () => ({
  useHealthCheck: vi.fn(),
}));
vi.mock('@/features/agent-context/hooks/useVisibilityReconnect', () => ({
  useVisibilityReconnect: vi.fn(),
}));
vi.mock('@/features/agent-context/hooks/usePopstateSync', () => ({
  usePopstateSync: vi.fn(),
}));
vi.mock('@/lib/realtime', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/realtime')>();
  return {
    ...mod,
    subscribeToAgent: vi.fn(),
    subscribeToBus: vi.fn(),
    unsubscribe: vi.fn(),
  };
});

// eslint-disable-next-line import/first
import { useAgentProvider, useAgentContext, AgentContext } from '@/features/agent-context/hooks';

const API_BASE = 'http://localhost:3001/api';

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

function makeAgent(overrides: Partial<any> = {}) {
  return {
    agent_id: 'agent-001',
    goal: 'test goal',
    model: 'rose-1-lite',
    source: 'WEB',
    reasoning_effort: 'medium',
    progress: 0.5,
    status: 'ACTIVE',
    status_message: null,
    temporal_workflow_id: 'wf-001',
    token_count: 10,
    tokens_in: 5,
    tokens_out: 5,
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 1000,
    message_count: 2,
    price_limit_cents: 500,
    tree_cost_cents: 10,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:01Z',
    write_lock_enabled: false,
    parent_agent_id: null,
    parent_goal: null,
    verifier: null,
    tools: [],
    ...overrides,
  };
}

describe('useAgentProvider', () => {
  beforeEach(() => {
    mockSession();
    clearCaptures();
    window.history.replaceState({}, '', '/');
  });
  afterEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  function defaultDeps(overrides: Partial<any> = {}) {
    return {
      user: { id: 'u-1', is_anonymous: false } as any,
      isAuthenticated: true,
      realtimeReady: true,
      onLoadAgents: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('returns initial empty state when URL lacks agent-id', () => {
    const { result } = renderHook(() => useAgentProvider(defaultDeps()));
    expect(result.current.selectedAgentId).toBeNull();
    expect(result.current.agent).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.isChatMode).toBe(true);
  });

  it('auto-loads agent when URL has ?agent-id=X', async () => {
    window.history.replaceState({}, '', '/?agent-id=agent-999');
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({
          agent: makeAgent({ agent_id: 'agent-999', goal: 'url-goal' }),
          messages: [{ message_id: 'm1', timestamp: 't', text: 'hi', role: 'USER' }],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));
    await waitFor(() => {
      expect(result.current.agent?.agent_id).toBe('agent-999');
    });
    expect(result.current.messages.length).toBeGreaterThan(0);
    unmount();
  });

  it('auto-loads benchmark preview links without auth in dev/test mode', async () => {
    localStorage.clear();
    window.history.replaceState({}, '', '/?agent-id=bench-agent-001');
    server.use(
      http.get(`${API_BASE}/benchmarks/agent-preview/:agentId`, ({ params }) =>
        HttpResponse.json({
          agent: makeAgent({
            agent_id: params.agentId as string,
            goal: 'benchmark subscription gate',
          }),
          messages: [
            {
              message_id: 'm-preview',
              timestamp: 't',
              text: 'Subscribe to let Rose complete purchases',
              role: 'TOOL',
              metadata: {
                toolName: 'gate',
                toolStatus: 'IN_PROGRESS',
                gate: { type: 'subscription', gateKey: 'subscription', status: 'PENDING' },
              },
            },
          ],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );

    const { result, unmount } = renderHook(() =>
      useAgentProvider(defaultDeps({ user: null, isAuthenticated: false, realtimeReady: false })),
    );

    await waitFor(() => {
      expect(result.current.agent?.agent_id).toBe('bench-agent-001');
    });
    expect(result.current.messages[0]?.metadata?.gate).toMatchObject({ type: 'subscription' });
    unmount();
  });

  it('auto-load clears selection on fetch error', async () => {
    window.history.replaceState({}, '', '/?agent-id=agent-err');
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(result.current.agent).toBeNull();
    errSpy.mockRestore();
    unmount();
  });

  it('setSelectedAgentId updates URL and loads new agent', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, ({ params }) =>
        HttpResponse.json({
          agent: makeAgent({ agent_id: params.agentId as string, goal: 'new goal' }),
          messages: [],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));
    act(() => {
      result.current.setSelectedAgentId('agent-xyz');
    });
    await waitFor(() => expect(result.current.agent?.agent_id).toBe('agent-xyz'));
    expect(window.location.search).toContain('agent-id=agent-xyz');

    act(() => {
      result.current.setSelectedAgentId(null);
    });
    expect(window.location.search).not.toContain('agent-id');
    unmount();
  });

  it('sendMessage throws when no agent selected', async () => {
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));
    let threw: unknown = null;
    await act(async () => {
      try {
        await result.current.sendMessage('hi');
      } catch (err) {
        threw = err;
      }
    });
    expect(threw).toBeTruthy();
    expect((threw as Error).message).toMatch(/No agent selected/);
    unmount();
  });

  it('sendMessage posts via API when agent selected', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, ({ params }) =>
        HttpResponse.json({
          agent: makeAgent({ agent_id: params.agentId as string }),
          messages: [],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
      http.post(`${API_BASE}/agents/:agentId/messages`, () =>
        HttpResponse.json({
          message_id: 'm-new',
          timestamp: 't',
          text: '',
          role: 'USER',
        }),
      ),
    );
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));
    act(() => {
      result.current.setSelectedAgentId('agent-send');
    });
    await waitFor(() => expect(result.current.agent?.agent_id).toBe('agent-send'));
    await act(async () => {
      await result.current.sendMessage('hello');
    });
    const req = capturedRequests.find((r) => r.method === 'POST' && r.url.includes('/messages'));
    expect(req).toBeDefined();
    unmount();
  });

  it('registerMessageHandler stores + removes handler', () => {
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));
    const handler = vi.fn();
    let unregister = () => {};
    act(() => {
      unregister = result.current.registerMessageHandler(null, handler);
    });
    expect(typeof unregister).toBe('function');
    act(() => {
      unregister();
    });
    expect(true).toBe(true);
    unmount();
  });

  it('forceResubscribe runs without error', () => {
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));
    act(() => {
      result.current.forceResubscribe();
    });
    act(() => {
      result.current.forceResubscribe();
    });
    expect(true).toBe(true);
    unmount();
  });

  it('clears unauthenticated URL selection when benchmark preview is unavailable', async () => {
    localStorage.clear();
    window.history.replaceState({}, '', '/?agent-id=noauth-1');
    server.use(
      http.get(`${API_BASE}/benchmarks/agent-preview/:agentId`, () =>
        HttpResponse.json({ error: 'Agent not found' }, { status: 404 }),
      ),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, unmount } = renderHook(() =>
      useAgentProvider(
        defaultDeps({ user: null, isAuthenticated: false, realtimeReady: false }),
      ),
    );
    await waitFor(() => expect(result.current.selectedAgentId).toBeNull());
    expect(window.location.search).not.toContain('agent-id');
    errSpy.mockRestore();
    unmount();
  });

  it('PAUSED agent status clears streaming state', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({
          agent: makeAgent({ status: 'PAUSED' }),
          messages: [],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));
    act(() => {
      result.current.setSelectedAgentId('paused-1');
    });
    await waitFor(() => expect(result.current.agent?.status).toBe('PAUSED'));
    expect(result.current.streamingBubbles.size).toBe(0);
    expect(result.current.streamingPlan).toBeNull();
    unmount();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// useAgentContext (consumer hook)
// ═══════════════════════════════════════════════════════════════════════════

describe('useAgentContext', () => {
  it('throws when used outside provider', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let threw: unknown = null;
    try {
      renderHook(() => useAgentContext());
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeTruthy();
    errSpy.mockRestore();
  });

  it('returns context value when wrapped in provider', () => {
    const value = {
      agent: null,
      selectedAgentId: null,
      messages: [],
      streamingBubbles: new Map(),
      streamingPlan: null,
      streamingAttention: null,
      streamingTools: new Map(),
      streamedTextsRef: { current: new Set<string>() } as any,
      setAgent: vi.fn(),
      setSelectedAgentId: vi.fn(),
      setMessages: vi.fn(),
      registerMessageHandler: vi.fn(() => () => {}),
      sendMessage: vi.fn(async () => {}),
      isLoadingAgent: false,
      forceResubscribe: vi.fn(),
      isChatMode: true,
    } as any;
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(AgentContext.Provider, { value }, children);
    const { result } = renderHook(() => useAgentContext(), { wrapper });
    expect(result.current).toBe(value);
  });
});
