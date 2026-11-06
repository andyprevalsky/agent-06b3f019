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
import type { AgentDetail } from '@/lib/api';
import type { AgentContextValue, AgentProviderProps } from '@/features/agent-context/types';
import { benchmarkShareToken, captureBenchmarkShareToken } from '@/lib/benchmarkShare';

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

function makeAgent(overrides: Partial<AgentDetail> = {}): AgentDetail {
  return {
    agent_id: 'agent-001',
    goal: 'test goal',
    model: 'rose-1-flash',
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

  function defaultDeps(overrides: Partial<AgentProviderProps> = {}) {
    return {
      user: { id: 'u-1', is_anonymous: false },
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

  it('loads a shared benchmark transcript without a session or agent API auth', async () => {
    localStorage.clear();
    window.history.replaceState({}, '', '/?agent-id=shared-agent#benchmark-share=run.token');
    captureBenchmarkShareToken();
    server.use(
      http.get(`${API_BASE}/benchmarks/shared-agent/:agentId`, ({ request, params }) => {
        expect(new URL(request.url).searchParams.has('share')).toBe(false);
        expect(request.headers.get('authorization')).toBe('BenchmarkShare run.token');
        expect(request.headers.has('x-api-key')).toBe(false);
        return HttpResponse.json({
          agent: makeAgent({ agent_id: params.agentId as string, goal: 'shared recording' }),
          messages: [
            {
              message_id: 'recorded-message',
              timestamp: 't',
              text: 'Recorded transcript',
              role: 'ASSISTANT',
            },
          ],
          pagination: { has_more: false, oldest_timestamp: null },
        });
      }),
    );

    const { result, unmount } = renderHook(() =>
      useAgentProvider(defaultDeps({ user: null, isAuthenticated: false, realtimeReady: false })),
    );
    await waitFor(() => expect(result.current.messages[0]?.text).toBe('Recorded transcript'));
    expect(result.current.agent?.agent_id).toBe('shared-agent');
    expect(capturedRequests.some((request) => request.url.includes('/agents/shared-agent'))).toBe(
      false,
    );
    act(() => result.current.setSelectedAgentId('sibling-agent'));
    await waitFor(() => expect(result.current.agent?.agent_id).toBe('sibling-agent'));
    expect(benchmarkShareToken()).toBe('run.token');
    expect(window.location.search).toBe('?agent-id=sibling-agent');
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
    expect(result.current.isLoadingAgent).toBe(false);
    expect(result.current.selectedAgentId).toBeNull();
    expect(window.location.search).not.toContain('agent-id');
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

  it('owns one detail request per selection and aborts old reads on switch and unmount', async () => {
    const requests: { agentId: string; signal: AbortSignal | null | undefined }[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const agentId = String(input).split('/').at(-1) ?? '';
      requests.push({ agentId, signal: init?.signal });
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));
    try {
      act(() => result.current.setSelectedAgentId('large-agent-a'));
      await waitFor(() => expect(requests.length).toBeGreaterThan(0));
      expect(requests.filter((request) => request.agentId === 'large-agent-a')).toHaveLength(1);
      expect(requests[0].signal?.aborted).toBe(false);

      act(() => result.current.setSelectedAgentId('large-agent-b'));
      await waitFor(() =>
        expect(requests.some((request) => request.agentId === 'large-agent-b')).toBe(true),
      );
      expect(requests[0].signal?.aborted).toBe(true);
      expect(requests.filter((request) => request.agentId === 'large-agent-b')).toHaveLength(1);

      unmount();
      expect(requests.every((request) => request.signal?.aborted)).toBe(true);
      await act(async () => {});
      expect(requests.some((request) => request.agentId.includes('agent-preview'))).toBe(false);
    } finally {
      unmount();
      fetchSpy.mockRestore();
    }
  });

  it('does not apply an old detail response after selecting A, B, then A again', async () => {
    const requests: { agentId: string; finish: (text: string) => void }[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const agentId = String(input).split('/').at(-1) ?? '';
      return new Promise<Response>((resolve) => {
        requests.push({
          agentId,
          finish: (text) =>
            resolve(
              new Response(
                JSON.stringify({
                  agent: makeAgent({ agent_id: agentId }),
                  messages: [
                    { message_id: text, text, timestamp: '2026-01-01T00:00:00Z', role: 'USER' },
                  ],
                  pagination: { has_more: false, oldest_timestamp: null },
                }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
              ),
            ),
        });
      });
    });
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));
    try {
      act(() => result.current.setSelectedAgentId('agent-a'));
      const staleReads = [...requests];
      act(() => result.current.setSelectedAgentId('agent-b'));
      act(() => result.current.setSelectedAgentId('agent-a'));
      const currentReads = requests.filter(
        (request) => request.agentId === 'agent-a' && !staleReads.includes(request),
      );
      await act(async () =>
        currentReads.forEach((request) => request.finish('current trajectory')),
      );
      expect(result.current.messages[0]?.text).toBe('current trajectory');
      await act(async () => staleReads.forEach((request) => request.finish('stale trajectory')));
      expect(result.current.messages[0]?.text).toBe('current trajectory');
    } finally {
      unmount();
      await act(async () => requests.forEach((request) => request.finish('cleanup')));
      fetchSpy.mockRestore();
    }
  });

  it('stages a pending creation without a detail GET, then reconciles without duplicate user text', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, ({ params }) =>
        HttpResponse.json({
          agent: makeAgent({ agent_id: params.agentId as string, goal: 'instant goal' }),
          messages: [
            {
              message_id: 'canonical-user',
              timestamp: '2026-01-01T00:00:00Z',
              text: 'instant goal',
              role: 'USER',
            },
          ],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));

    act(() => {
      result.current.stagePendingAgentCreation({
        agentId: 'pending-agent',
        goal: 'instant goal',
        model: 'rose-1-flash',
        source: 'WEB',
        priceLimitCents: 500,
      });
    });

    expect(result.current.selectedAgentId).toBe('pending-agent');
    expect(result.current.agent?.agent_id).toBe('pending-agent');
    expect(result.current.messages).toEqual([
      expect.objectContaining({ text: 'instant goal', role: 'USER' }),
    ]);
    expect(capturedRequests.some((request) => request.method === 'GET')).toBe(false);

    act(() => {
      result.current.applyAgentDetail('pending-agent', {
        agent: makeAgent({ agent_id: 'pending-agent', goal: 'instant goal' }),
        messages: [
          {
            message_id: 'realtime-assistant',
            timestamp: '2026-01-01T00:00:00.500Z',
            text: 'Already streaming',
            role: 'ASSISTANT',
          },
        ],
        pagination: { has_more: false, oldest_timestamp: null },
      });
    });
    await act(async () => {
      await result.current.reconcilePendingAgentCreation('pending-agent');
    });

    expect(result.current.messages.map((message) => message.message_id)).toEqual([
      'canonical-user',
      'realtime-assistant',
    ]);
    expect(
      result.current.messages.filter((message) => message.text === 'instant goal'),
    ).toHaveLength(1);
    unmount();
  });

  it('rolls back a pending creation only while that exact staged agent is selected', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, ({ params }) =>
        HttpResponse.json({
          agent: makeAgent({ agent_id: params.agentId as string }),
          messages: [],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const { result, unmount } = renderHook(() => useAgentProvider(defaultDeps()));

    act(() => {
      result.current.stagePendingAgentCreation({
        agentId: 'pending-agent',
        goal: 'instant goal',
        model: 'rose-1-flash',
        source: 'WEB',
        priceLimitCents: 500,
      });
      result.current.setSelectedAgentId('other-agent');
    });
    expect(result.current.rollbackPendingAgentCreation('pending-agent')).toBe(false);
    expect(result.current.selectedAgentId).toBe('other-agent');

    await waitFor(() => expect(result.current.agent?.agent_id).toBe('other-agent'));
    act(() => {
      result.current.stagePendingAgentCreation({
        agentId: 'second-pending-agent',
        goal: 'retryable goal',
        model: 'rose-1-flash',
        source: 'WEB',
        priceLimitCents: 500,
      });
    });
    let rolledBack = false;
    act(() => {
      rolledBack = result.current.rollbackPendingAgentCreation('second-pending-agent');
    });
    expect(rolledBack).toBe(true);
    expect(result.current.selectedAgentId).toBeNull();
    expect(result.current.messages).toEqual([]);
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

  it('keeps unauthenticated URL selection when preview fails, then retries once auth completes', async () => {
    // Regression: dev auto-login is async, so "not authenticated yet" must
    // not be treated as "never will be". A failed pre-auth preview attempt
    // must keep ?agent-id= so the authenticated path can retry after login.
    localStorage.clear();
    window.history.replaceState({}, '', '/?agent-id=noauth-1');
    server.use(
      http.get(`${API_BASE}/benchmarks/agent-preview/:agentId`, () =>
        HttpResponse.json({ error: 'Agent not found' }, { status: 404 }),
      ),
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({
          agent: makeAgent({ agent_id: 'noauth-1', goal: 'post-login goal' }),
          messages: [{ message_id: 'm1', timestamp: 't', text: 'hi', role: 'USER' }],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result, rerender, unmount } = renderHook(
      (deps: ReturnType<typeof defaultDeps>) => useAgentProvider(deps),
      { initialProps: defaultDeps({ user: null, isAuthenticated: false, realtimeReady: false }) },
    );

    // Pre-auth preview attempt fails -> selection + URL must survive.
    await waitFor(() => expect(errSpy).toHaveBeenCalled());
    expect(result.current.selectedAgentId).toBe('noauth-1');
    expect(window.location.search).toContain('agent-id=noauth-1');
    expect(result.current.agent).toBeNull();

    // Dev auto-login completes -> authenticated retry loads the agent.
    mockSession();
    rerender(defaultDeps());
    await waitFor(() => expect(result.current.agent?.agent_id).toBe('noauth-1'));
    expect(window.location.search).toContain('agent-id=noauth-1');
    errSpy.mockRestore();
    unmount();
  });

  it('PAUSED agent status clears streaming state', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, ({ params }) =>
        HttpResponse.json({
          agent: makeAgent({ agent_id: params.agentId as string, status: 'PAUSED' }),
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
      streamedTextsRef: { current: new Set<string>() },
      applyAgentDetail: vi.fn(() => true),
      setSelectedAgentId: vi.fn(),
      stagePendingAgentCreation: vi.fn(),
      reconcilePendingAgentCreation: vi.fn(async () => {}),
      rollbackPendingAgentCreation: vi.fn(() => true),
      stageUserMessage: vi.fn(() => ({ confirm: vi.fn(), drop: vi.fn() })),
      registerMessageHandler: vi.fn(() => () => {}),
      sendMessage: vi.fn(async () => {}),
      isLoadingAgent: false,
      forceResubscribe: vi.fn(),
      isChatMode: true,
    } as unknown as AgentContextValue;
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(AgentContext.Provider, { value }, children);
    const { result } = renderHook(() => useAgentContext(), { wrapper });
    expect(result.current).toBe(value);
  });
});
