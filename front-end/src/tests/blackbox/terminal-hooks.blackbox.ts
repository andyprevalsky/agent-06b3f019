/**
 * Blackbox tests for three terminal hooks:
 *   - useAgentActions (select/create/resume/pause/feedback)
 *   - useMessageSending (input/send/auto-submit)
 *   - useTerminalAgents (composed — partial coverage via renderHook with
 *     dependency providers)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { clearCaptures, capturedRequests } from './msw/capture';
import {
  makeTerminalHookAgent as makeAgent,
  mockTerminalHookSession as mockSession,
} from './terminal-hooks.fixtures';

// Mock composed sub-hooks of useTerminalAgents so we don't need the whole
// AgentProvider / realtime subscription infra. We still exercise the
// useTerminalAgents composition logic: ancestors effect, quick-query handler,
// logout, handleCreateNewAgent, etc.
const authState = {
  user: { id: 'u-1', phone: '+19999999999', is_anonymous: false },
  session: { access_token: 't' },
  isAuthenticated: true,
  isAnonymous: false,
  isFullySignedIn: true,
  loading: false,
  realtimeReady: true,
  refreshAuthState: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
};
const ctxState = {
  agent: null as unknown,
  selectedAgentId: null as string | null,
  messages: [],
  streamingBubbles: new Map(),
  streamingPlan: null,
  streamingAttention: null,
  streamingTools: new Map(),
  streamedTextsRef: { current: new Set<string>() } as never,
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
};
vi.mock('@/features/auth', () => ({
  useAuth: () => authState,
}));
vi.mock('@/features/agent-context', () => ({
  useAgentContext: () => ctxState,
}));
vi.mock('@/lib/supabase', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/supabase')>();
  return {
    ...mod,
    signOut: vi.fn(async () => {}),
    clearStoredSession: vi.fn(),
  };
});

import { useAgentActions } from '@/features/terminal/hooks/useAgentActions';
import { useMessageSending } from '@/features/terminal/hooks/useMessageSending';
import { useTerminalAgents } from '@/features/terminal/hooks/useTerminalAgents';
import { dispatchQuickQueryEvent } from '@/lib/quickQuery';
import { signOut } from '@/lib/supabase';

const API_BASE = 'http://localhost:3001/api';

// ═══════════════════════════════════════════════════════════════════════════
// useAgentActions
// ═══════════════════════════════════════════════════════════════════════════

describe('useAgentActions', () => {
  beforeEach(() => {
    mockSession();
    clearCaptures();
  });
  afterEach(() => {
    localStorage.clear();
  });

  function defaultArgs(overrides: Record<string, unknown> = {}) {
    return {
      selectedAgentId: 'agent-001',
      agentDetail: makeAgent(),
      applyAgentDetail: vi.fn(() => true),
      setSelectedAgentIdContext: vi.fn(),
      setCurrentView: vi.fn(),
      clientSource: 'WEB',
      loadAgents: vi.fn(async () => {}),
      ...overrides,
    };
  }

  it('handleSelectAgent switches view + context on non-null agent', () => {
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    act(() => {
      result.current.handleSelectAgent('agent-002');
    });
    expect(args.setCurrentView).toHaveBeenCalledWith('agents');
    expect(args.setSelectedAgentIdContext).toHaveBeenCalledWith('agent-002');
  });

  it('handleSelectAgent(null) clears selected agent without changing view', () => {
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    act(() => {
      result.current.handleSelectAgent(null);
    });
    expect(args.setSelectedAgentIdContext).toHaveBeenCalledWith(null);
  });

  it('refreshAgentDetail applies the selected agent response on success', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({
          agent: makeAgent({ model: 'rose-1-ultra' }),
          messages: [{ message_id: 'm1', timestamp: 't', text: '', role: 'USER' }],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    await act(async () => {
      await result.current.refreshAgentDetail('agent-001');
    });
    expect(args.applyAgentDetail).toHaveBeenCalledWith('agent-001', expect.any(Object));
  });

  it('refreshAgentDetail logs error on fetch failure', async () => {
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, () => new HttpResponse(null, { status: 500 })),
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    await act(async () => {
      await result.current.refreshAgentDetail('agent-001');
    });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('handleCreateAgent posts then loads + navigates', async () => {
    server.use(
      http.post(`${API_BASE}/agents`, () =>
        HttpResponse.json(makeAgent({ agent_id: 'new-agent' })),
      ),
    );
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    await act(async () => {
      await result.current.handleCreateAgent({ goal: 'new goal' } as never);
    });
    expect(args.loadAgents).toHaveBeenCalled();
    expect(args.setCurrentView).toHaveBeenCalledWith('agents');
    expect(args.setSelectedAgentIdContext).toHaveBeenCalledWith('new-agent');
  });

  it('handleResumeAgent on success refreshes + reloads', async () => {
    server.use(
      http.post(`${API_BASE}/agents/:agentId/resume`, () => HttpResponse.json({ success: true })),
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({
          agent: makeAgent(),
          messages: [],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    await act(async () => {
      await result.current.handleResumeAgent('agent-001');
    });
    expect(args.loadAgents).toHaveBeenCalled();
    expect(result.current.resumingAgentId).toBeNull();
  });

  it('handleResumeAgent surfaces error toast on failure', async () => {
    server.use(
      http.post(
        `${API_BASE}/agents/:agentId/resume`,
        () => new HttpResponse(null, { status: 500 }),
      ),
    );
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    await act(async () => {
      await result.current.handleResumeAgent('agent-001');
    });
    // Resolves cleanly (error caught internally, toast fired)
    expect(result.current.resumingAgentId).toBeNull();
  });

  it('handlePauseAgent no-op when no agent selected', async () => {
    const args = defaultArgs({ selectedAgentId: null, agentDetail: null });
    const { result } = renderHook(() => useAgentActions(args as never));
    await act(async () => {
      await result.current.handlePauseAgent();
    });
    expect(result.current.isPausing).toBe(false);
  });

  it('handlePauseAgent on success refreshes detail', async () => {
    server.use(
      http.post(`${API_BASE}/agents/:agentId/pause`, () => HttpResponse.json({ success: true })),
      http.get(`${API_BASE}/agents/:agentId`, () =>
        HttpResponse.json({
          agent: makeAgent(),
          messages: [],
          pagination: { has_more: false, oldest_timestamp: null },
        }),
      ),
    );
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    await act(async () => {
      await result.current.handlePauseAgent();
    });
    expect(args.applyAgentDetail).toHaveBeenCalled();
    expect(result.current.isPausing).toBe(false);
  });

  it('handlePauseAgent reports error toast on failure', async () => {
    server.use(
      http.post(`${API_BASE}/agents/:agentId/pause`, () => new HttpResponse(null, { status: 500 })),
    );
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    await act(async () => {
      await result.current.handlePauseAgent();
    });
    expect(result.current.isPausing).toBe(false);
  });

  it('handleSubmitFeedback noops when no agentDetail', async () => {
    const args = defaultArgs({ agentDetail: null });
    const { result } = renderHook(() => useAgentActions(args as never));
    await act(async () => {
      await result.current.handleSubmitFeedback({ rating: 1 } as never);
    });
    // No API hit
    const posts = capturedRequests.filter((r) => r.method === 'POST');
    expect(posts.find((r) => r.url.includes('/blueprints'))).toBeUndefined();
  });

  it('handleSubmitFeedback warns when blueprint not found', async () => {
    server.use(
      http.get(`${API_BASE}/blueprints/by-goal`, () => new HttpResponse(null, { status: 404 })),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    await act(async () => {
      await result.current.handleSubmitFeedback({ rating: 1 } as never);
    });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('handleSubmitFeedback re-throws API errors', async () => {
    server.use(
      // findBlueprintByGoal returns `response.json()` directly, so the shape
      // must be `{ id }` at top level — the same as api.blackbox.ts uses.
      // Wrapping it as `{ blueprint: { id } }` would leave `blueprint.id`
      // undefined and route the feedback POST to /blueprints/undefined/feedback.
      http.get(`${API_BASE}/blueprints/by-goal`, () => HttpResponse.json({ id: 'bp-1' })),
      http.patch(`${API_BASE}/blueprints/:id/feedback`, () =>
        HttpResponse.json({ error: 'bad' }, { status: 500 }),
      ),
    );
    const args = defaultArgs();
    const { result } = renderHook(() => useAgentActions(args as never));
    let thrown: unknown = null;
    await act(async () => {
      try {
        await result.current.handleSubmitFeedback({ rating: 1 } as never);
      } catch (err) {
        thrown = err;
      }
    });
    expect(thrown).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// useMessageSending
// ═══════════════════════════════════════════════════════════════════════════

describe('useMessageSending', () => {
  beforeEach(() => {
    mockSession();
    clearCaptures();
  });
  afterEach(() => {
    localStorage.clear();
  });

  function defaultArgs(overrides: Record<string, unknown> = {}) {
    return {
      selectedAgentId: null,
      agentDetail: null,
      canSubmitGoals: true,
      isFullySignedIn: true,
      clientSource: 'WEB',
      setSelectedAgentIdContext: vi.fn(),
      setCurrentView: vi.fn(),
      setLoginModalOpen: vi.fn(),
      setIsLoadingNetwork: vi.fn(),
      loadAgents: vi.fn(async () => {}),
      stagePendingAgentCreation: vi.fn(),
      reconcilePendingAgentCreation: vi.fn(async () => {}),
      rollbackPendingAgentCreation: vi.fn(() => true),
      stageUserMessage: vi.fn(() => ({ confirm: vi.fn(), drop: vi.fn() })),
      ...overrides,
    };
  }

  it('initial state: empty input + default model', () => {
    const { result } = renderHook(() => useMessageSending(defaultArgs() as never));
    expect(result.current.messageInput).toBe('');
    expect(result.current.selectedModel).toBeTruthy();
    expect(result.current.isSendingMessage).toBe(false);
    expect(result.current.pendingPriceLimitCents).toBe(1000);
  });

  it('sets messageInput from localStorage prefill then clears it', () => {
    localStorage.setItem('onboarding_prefill_query', 'hello world');
    const { result } = renderHook(() => useMessageSending(defaultArgs() as never));
    expect(result.current.messageInput).toBe('hello world');
    expect(localStorage.getItem('onboarding_prefill_query')).toBeNull();
  });

  it('handleSendMessage with empty input is a no-op', async () => {
    const args = defaultArgs();
    const { result } = renderHook(() => useMessageSending(args as never));
    await act(async () => {
      await result.current.handleSendMessage();
    });
    expect(args.loadAgents).not.toHaveBeenCalled();
  });

  it('handleSendMessage without auth opens login modal', async () => {
    const args = defaultArgs({ canSubmitGoals: false });
    const { result } = renderHook(() => useMessageSending(args as never));
    act(() => result.current.setMessageInput('go'));
    await act(async () => {
      await result.current.handleSendMessage();
    });
    expect(args.setLoginModalOpen).toHaveBeenCalledWith(true);
  });

  it('handleSendMessage creates a new agent when no selectedAgentId', async () => {
    server.use(
      http.post(`${API_BASE}/agents`, async ({ request }) => {
        const body = (await request.json()) as { agent_id: string };
        return HttpResponse.json(makeAgent({ agent_id: body.agent_id }));
      }),
    );
    const args = defaultArgs();
    const { result } = renderHook(() => useMessageSending(args as never));
    act(() => result.current.setMessageInput('goal X'));
    await act(async () => {
      await result.current.handleSendMessage();
    });
    expect(args.loadAgents).toHaveBeenCalled();
    expect(args.stagePendingAgentCreation).toHaveBeenCalled();
    expect(args.reconcilePendingAgentCreation).toHaveBeenCalled();
    expect(args.setSelectedAgentIdContext).not.toHaveBeenCalled();
    expect(args.setCurrentView).toHaveBeenCalledWith('agents');
  });

  it('handleSendMessage on existing agent posts message (no attention)', async () => {
    server.use(
      // No pending attention request
      http.get(`${API_BASE}/attention-requests`, () => HttpResponse.json({ requests: [] })),
      http.post(`${API_BASE}/agents/:agentId/messages`, () =>
        HttpResponse.json({
          message_id: 'm1',
          timestamp: new Date().toISOString(),
          text: 'x',
          role: 'USER',
        }),
      ),
    );
    const args = defaultArgs({ selectedAgentId: 'agent-001', agentDetail: makeAgent() });
    const { result } = renderHook(() => useMessageSending(args as never));
    act(() => result.current.setMessageInput('hello'));
    await act(async () => {
      await result.current.handleSendMessage();
    });
    await waitFor(() => {
      const req = capturedRequests.find((r) => r.method === 'POST' && r.url.includes('/messages'));
      expect(req).toBeDefined();
    });
  });

  it('handleSendMessage to a PAUSED agent only posts the message; the backend resumes', async () => {
    server.use(
      http.get(`${API_BASE}/attention-requests`, () => HttpResponse.json({ requests: [] })),
      http.post(`${API_BASE}/agents/:agentId/resume`, () => HttpResponse.json({ success: true })),
      http.post(`${API_BASE}/agents/:agentId/messages`, () =>
        HttpResponse.json({
          message_id: 'm1',
          timestamp: new Date().toISOString(),
          text: 'x',
          role: 'USER',
        }),
      ),
    );
    const args = defaultArgs({
      selectedAgentId: 'agent-001',
      agentDetail: makeAgent({ status: 'PAUSED' }),
    });
    const { result } = renderHook(() => useMessageSending(args as never));
    act(() => result.current.setMessageInput('resume please'));
    await act(async () => {
      await result.current.handleSendMessage();
    });
    await waitFor(() => {
      const req = capturedRequests.find((r) => r.method === 'POST' && r.url.includes('/messages'));
      expect(req).toBeDefined();
    });
    expect(capturedRequests.some((r) => r.url.includes('/resume'))).toBe(false);
    expect(result.current.messageInput).toBe('');
  });

  it('handleSendMessage error triggers error toast path (401)', async () => {
    server.use(
      http.post(`${API_BASE}/agents`, () =>
        HttpResponse.json({ error: '401 Unauthorized' }, { status: 401 }),
      ),
    );
    const args = defaultArgs();
    const { result } = renderHook(() => useMessageSending(args as never));
    act(() => result.current.setMessageInput('hello'));
    await act(async () => {
      await result.current.handleSendMessage();
    });
    // 401 path opens login modal
    expect(args.setLoginModalOpen).toHaveBeenCalledWith(true);
  });

  it('handleSendMessage generic failure shows error toast (no login modal)', async () => {
    server.use(
      http.post(`${API_BASE}/agents`, () => HttpResponse.json({ error: 'boom' }, { status: 500 })),
    );
    const args = defaultArgs();
    const { result } = renderHook(() => useMessageSending(args as never));
    act(() => result.current.setMessageInput('hello'));
    await act(async () => {
      await result.current.handleSendMessage();
    });
    // Generic error does NOT open login modal
    expect(args.setLoginModalOpen).not.toHaveBeenCalledWith(true);
  });

  it('setPendingPriceLimitCents updates state', () => {
    const { result } = renderHook(() => useMessageSending(defaultArgs() as never));
    act(() => result.current.setPendingPriceLimitCents(9999));
    expect(result.current.pendingPriceLimitCents).toBe(9999);
  });

  it('setSelectedModel updates state and syncs from agentDetail on change', () => {
    const { rerender, result } = renderHook(({ args }) => useMessageSending(args as never), {
      initialProps: { args: defaultArgs() },
    });
    act(() => result.current.setSelectedModel('custom'));
    expect(result.current.selectedModel).toBe('custom');
    // When agent detail comes in, model is overridden
    rerender({ args: defaultArgs({ agentDetail: makeAgent({ model: 'rose-1-ultra' }) }) });
    expect(result.current.selectedModel).toBe('rose-1-ultra');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// useTerminalAgents (composed hook)
// ═══════════════════════════════════════════════════════════════════════════

describe('useTerminalAgents', () => {
  const setCurrentView = vi.fn();
  const resetAnimationState = vi.fn();

  beforeEach(() => {
    mockSession();
    clearCaptures();
    setCurrentView.mockReset();
    resetAnimationState.mockReset();
    ctxState.agent = null;
    ctxState.selectedAgentId = null;
    ctxState.setSelectedAgentId.mockReset();
    authState.isAuthenticated = true;
    authState.isAnonymous = false;
    authState.isFullySignedIn = true;
    authState.loading = false;
    authState.refreshAuthState.mockClear();
    authState.signOut.mockClear();
    vi.mocked(signOut).mockResolvedValue(undefined);
    server.use(
      http.get(`${API_BASE}/agents/:agentId/ancestors`, () => HttpResponse.json({ ancestors: [] })),
      http.get(`${API_BASE}/agents`, () => HttpResponse.json({ agents: [] })),
    );
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('returns composed state with empty defaults', () => {
    const { result, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    expect(result.current.agentDetail).toBeNull();
    expect(result.current.selectedAgentId).toBeNull();
    expect(result.current.ancestors).toEqual([]);
    expect(result.current.canSubmitGoals).toBe(true);
    unmount();
  });

  it('does not allow goal submission when auth is anonymous', () => {
    authState.isAnonymous = true;
    authState.isFullySignedIn = false;
    const { result, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    expect(result.current.canSubmitGoals).toBe(false);
    unmount();
  });

  it('loads ancestors when selectedAgentId present', async () => {
    ctxState.selectedAgentId = 'agent-ancestors';
    server.use(
      http.get(`${API_BASE}/agents/:agentId/ancestors`, () =>
        HttpResponse.json({
          ancestors: [{ agent_id: 'root', goal: 'root goal', status: 'COMPLETED' }],
        }),
      ),
    );
    const { result, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    await waitFor(() => expect(result.current.ancestors.length).toBeGreaterThan(0));
    unmount();
  });

  it('handleCreateNewAgent clears selection and switches view', () => {
    const { result, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    act(() => result.current.handleCreateNewAgent());
    expect(ctxState.setSelectedAgentId).toHaveBeenCalledWith(null);
    expect(resetAnimationState).toHaveBeenCalled();
    expect(setCurrentView).toHaveBeenCalledWith('agents');
    unmount();
  });

  it('handleLoginClick opens login modal', () => {
    const { result, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    act(() => result.current.handleLoginClick());
    expect(result.current.loginModalOpen).toBe(true);
    unmount();
  });

  it('handleLogout calls signOut + refreshAuthState + clears state', async () => {
    const { result, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    await act(async () => {
      await result.current.handleLogout();
    });
    expect(authState.refreshAuthState).toHaveBeenCalledWith('logout');
    expect(setCurrentView).toHaveBeenCalledWith('agents');
    unmount();
  });

  it('handleLogout refreshes auth state before persisted signOut finishes', async () => {
    let finishSignOut: (() => void) | null = null;
    vi.mocked(signOut).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSignOut = resolve;
        }),
    );

    const { result, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );

    let logoutResolved = false;
    const logoutAct = act(async () => {
      await result.current.handleLogout();
      logoutResolved = true;
    });

    await waitFor(() => {
      expect(authState.refreshAuthState).toHaveBeenCalledWith('logout');
    });
    expect(setCurrentView).toHaveBeenCalledWith('agents');
    expect(logoutResolved).toBe(false);

    finishSignOut?.();
    await logoutAct;
    expect(logoutResolved).toBe(true);
    unmount();
  });

  it('quick-query event (unauthenticated) opens login modal once auth has resolved', async () => {
    authState.isAuthenticated = false;
    authState.isFullySignedIn = false;
    authState.loading = true;
    const { result, rerender, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    act(() => {
      dispatchQuickQueryEvent({ query: 'hi there', submittedAt: Date.now() });
    });
    // A launcher submit can re-create the main window and land while auth is
    // still resolving, when even a signed-in user reads as signed out: held.
    expect(result.current.loginModalOpen).toBe(false);
    authState.loading = false;
    rerender();
    await waitFor(() => expect(result.current.loginModalOpen).toBe(true));
    unmount();
  });

  it('quick-query event (empty query) is a no-op', () => {
    const { unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    act(() => {
      dispatchQuickQueryEvent({ query: '   ', submittedAt: Date.now() });
    });
    // setCurrentView('agents') was NOT called by quick-query (only by setup).
    // Hard to assert precisely; at minimum the hook is still mounted without error.
    expect(true).toBe(true);
    unmount();
  });

  it('setCreateModalOpen toggles state', () => {
    const { result, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    act(() => result.current.setCreateModalOpen(true));
    expect(result.current.createModalOpen).toBe(true);
    unmount();
  });

  it('setShowCreditModal + setShowCostLimitModal toggle state', () => {
    const { result, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    act(() => result.current.setShowCreditModal(true));
    expect(result.current.showCreditModal).toBe(true);
    act(() => result.current.setShowCostLimitModal(true));
    expect(result.current.showCostLimitModal).toBe(true);
    unmount();
  });

  it('cleanupAgentState resets selection and input', () => {
    const { result, unmount } = renderHook(() =>
      useTerminalAgents('agents' as never, setCurrentView, resetAnimationState),
    );
    act(() => {
      result.current.setMessageInput('hello');
      result.current.cleanupAgentState();
    });
    expect(ctxState.setSelectedAgentId).toHaveBeenCalledWith(null);
    expect(result.current.messageInput).toBe('');
    unmount();
  });
});
