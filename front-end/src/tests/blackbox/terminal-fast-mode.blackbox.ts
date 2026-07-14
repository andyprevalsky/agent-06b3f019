/**
 * Blackbox regression test for Fast Mode state wiring through useTerminalAgents.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { clearCaptures, capturedRequests } from './msw/capture';

const mocks = vi.hoisted(() => {
  const authState = {
    user: { id: '1f85ff25-6e29-4c1b-8739-f917bd101a30', phone: '+15555555555' },
    isAuthenticated: true,
    isAnonymous: false,
    isFullySignedIn: true,
    realtimeReady: true,
    refreshAuthState: vi.fn(),
    signOut: vi.fn(),
  };
  const ctxState = {
    agent: null,
    selectedAgentId: null,
    messages: [],
    streamingBubbles: new Map(),
    streamingPlan: null,
    streamingAttention: null,
    isLoadingAgent: false,
    isChatMode: false,
    setAgent: vi.fn(),
    setSelectedAgentId: vi.fn(),
    stagePendingAgentCreation: vi.fn(),
    reconcilePendingAgentCreation: vi.fn(async () => {}),
    rollbackPendingAgentCreation: vi.fn(() => true),
    setMessages: vi.fn(),
    forceResubscribe: vi.fn(),
  };
  return { authState, ctxState };
});

vi.mock('@/features/auth', () => ({
  useAuth: () => mocks.authState,
}));

vi.mock('@/features/agent-context', () => ({
  useAgentContext: () => mocks.ctxState,
}));

vi.mock('@/features/terminal/hooks/useAgentList', () => ({
  useAgentList: () => ({
    agents: [],
    isLoadingAgents: false,
    setAgents: vi.fn(),
    loadAgents: vi.fn(async () => {}),
  }),
}));

vi.mock('@/features/terminal/hooks/useAncestors', () => ({
  useAncestors: () => [],
}));

vi.mock('@/features/terminal/hooks/useQuickQuery', () => ({
  useQuickQuery: () => {},
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { useTerminalAgents } from '@/features/terminal/hooks/useTerminalAgents';
import { useMessageSending } from '@/features/terminal/hooks/useMessageSending';

const API_BASE = 'http://localhost:3001/api';

function mockSession() {
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: mocks.authState.user.id, is_anonymous: false },
    }),
  );
}

function messageSendingArgs(overrides: Partial<Parameters<typeof useMessageSending>[0]> = {}) {
  return {
    selectedAgentId: null,
    agentDetail: null,
    canSubmitGoals: true,
    isFullySignedIn: true,
    userId: mocks.authState.user.id,
    clientSource: 'WEB',
    setSelectedAgentIdContext: vi.fn(),
    setCurrentView: vi.fn(),
    setLoginModalOpen: vi.fn(),
    setIsLoadingNetwork: vi.fn(),
    loadAgents: vi.fn(async () => {}),
    stagePendingAgentCreation: vi.fn(),
    reconcilePendingAgentCreation: vi.fn(async () => {}),
    rollbackPendingAgentCreation: vi.fn(() => true),
    ...overrides,
  };
}

describe('useTerminalAgents Fast Mode bridge', () => {
  beforeEach(() => {
    mocks.authState.user.id = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
    mockSession();
    clearCaptures();
    server.use(
      http.post(`${API_BASE}/agents`, async ({ request }) => {
        const body = (await request.json()) as { agent_id: string };
        return HttpResponse.json({ agent_id: body.agent_id, status: 'ACTIVE' });
      }),
    );
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('defaults Andy to Fast Mode on and still allows switching off', async () => {
    const { result } = renderHook(() => useTerminalAgents('agents', vi.fn(), vi.fn()));

    await waitFor(() => expect(result.current.fastMode).toBe(true));

    act(() => result.current.setFastMode(false));

    expect(result.current.fastMode).toBe(false);
  });

  it('does not default other allow-listed accounts on', async () => {
    mocks.authState.user.id = '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9';
    const { result } = renderHook(() => useTerminalAgents('agents', vi.fn(), vi.fn()));

    await waitFor(() => expect(result.current.fastMode).toBe(false));
  });

  it('sends the current Fast Mode button state in create-agent payloads', async () => {
    const { result } = renderHook(() => useMessageSending(messageSendingArgs()));

    await waitFor(() => expect(result.current.fastMode).toBe(true));
    act(() => result.current.setMessageInput('make it fast'));
    await act(async () => {
      await result.current.handleSendMessage();
    });

    const createOn = capturedRequests.find((r) => r.method === 'POST' && r.url.endsWith('/agents'));
    expect(createOn?.body).toMatchObject({ fast_mode_cache_enabled: true });

    clearCaptures();
    act(() => {
      result.current.setFastMode(false);
      result.current.setMessageInput('make it explicit off');
    });
    await act(async () => {
      await result.current.handleSendMessage();
    });

    const createOff = capturedRequests.find(
      (r) => r.method === 'POST' && r.url.endsWith('/agents'),
    );
    expect(createOff?.body).toMatchObject({ fast_mode_cache_enabled: false });
  });

  it('hydrates Fast Mode from the loaded agent detail instead of the account default', async () => {
    const agentDetail = {
      agent_id: 'agent-loaded',
      model: 'rose-labs/rose-1-lite',
      fast_mode_cache_enabled: false,
    };

    const { result, rerender } = renderHook(
      ({ fastMode }: { fastMode: boolean }) =>
        useMessageSending(
          messageSendingArgs({
            selectedAgentId: 'agent-loaded',
            agentDetail: { ...agentDetail, fast_mode_cache_enabled: fastMode } as never,
          }),
        ),
      { initialProps: { fastMode: false } },
    );

    await waitFor(() => expect(result.current.fastMode).toBe(false));

    rerender({ fastMode: true });

    await waitFor(() => expect(result.current.fastMode).toBe(true));
  });
});
