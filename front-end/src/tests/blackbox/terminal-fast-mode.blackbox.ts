/**
 * Blackbox regression test for Fast Mode state wiring through useTerminalAgents.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { clearCaptures, capturedRequests } from './msw/capture';
import { ADMIN_ACCOUNTS } from '@/lib/adminAccounts';
import { resetQueryPreferencesMemory } from '@/lib/queryPreferences';
import {
  setUltraPreferred,
  useUltraPreferred,
  resetSpeedLevelSession,
} from '@/features/terminal-component-group/components/query-input/speedLevel';
import { resetFastModeSessionOverride } from '@/lib/fastModeSession';

const mocks = vi.hoisted(() => {
  const authState = {
    user: { id: 'c49b4ce3-3489-499d-bfbd-846d04ba6275', phone: '+15555555555' },
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
    applyAgentDetail: vi.fn(() => true),
    setSelectedAgentId: vi.fn(),
    stagePendingAgentCreation: vi.fn(),
    reconcilePendingAgentCreation: vi.fn(async () => {}),
    rollbackPendingAgentCreation: vi.fn(() => true),
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
    clientSource: 'WEB' as const,
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

afterEach(() => {
  resetQueryPreferencesMemory();
  resetSpeedLevelSession();
  for (const cookie of document.cookie.split(';')) {
    const key = cookie.trim().split('=')[0]!;
    if (key.startsWith('rose-query-defaults%3A')) document.cookie = `${key}=;Max-Age=0;Path=/`;
  }
});

describe('useTerminalAgents Fast Mode bridge', () => {
  beforeEach(() => {
    mocks.authState.user.id = ADMIN_ACCOUNTS[0]!.userId;
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
    resetFastModeSessionOverride();
  });

  it('defaults allow-listed accounts to Fast Mode on and still allows switching off', async () => {
    const { result } = renderHook(() => useTerminalAgents('agents', vi.fn(), vi.fn()));

    await waitFor(() => expect(result.current.fastMode).toBe(true));

    act(() => result.current.setFastMode(false));

    expect(result.current.fastMode).toBe(false);
  });

  it('defaults Fast Mode on for a phone-matched admin whose id is not allow-listed', async () => {
    const { result } = renderHook(() =>
      useMessageSending(
        messageSendingArgs({
          userId: 'not-an-allowlisted-admin-id',
          user: { id: 'not-an-allowlisted-admin-id', phone: '+19729777432' },
        }),
      ),
    );

    await waitFor(() => expect(result.current.fastMode).toBe(true));
  });

  it('defaults other allow-listed accounts on as well', async () => {
    mocks.authState.user.id = ADMIN_ACCOUNTS[1]!.userId;
    const { result } = renderHook(() => useTerminalAgents('agents', vi.fn(), vi.fn()));

    await waitFor(() => expect(result.current.fastMode).toBe(true));
  });

  it('sends all three speed levels independently of cache flags', async () => {
    const { result } = renderHook(() => useMessageSending(messageSendingArgs()));

    await waitFor(() => expect(result.current.fastMode).toBe(true));
    act(() => result.current.setMessageInput('make it fast'));
    await act(async () => {
      await result.current.handleSendMessage();
    });

    const createOn = capturedRequests.find((r) => r.method === 'POST' && r.url.endsWith('/agents'));
    expect(createOn?.body).toMatchObject({ speed: 'fast' });
    expect(createOn?.body).not.toHaveProperty('fast_mode_cache_enabled');

    clearCaptures();
    act(() => {
      setUltraPreferred(true, mocks.authState.user.id);
      result.current.setMessageInput('make it fast');
    });
    await act(async () => {
      await result.current.handleSendMessage();
    });
    const createFast = capturedRequests.find(
      (r) => r.method === 'POST' && r.url.endsWith('/agents'),
    );
    expect(createFast?.body).toMatchObject({ speed: 'ultrafast' });
    expect(createFast?.body).not.toHaveProperty('fast_mode_cache_enabled');

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
    expect(createOff?.body).toMatchObject({ speed: 'standard' });
    expect(createOff?.body).not.toHaveProperty('fast_mode_cache_enabled');
  });

  it.each(['standard', 'fast', 'ultrafast'] as const)(
    'hydrates %s from stored speed even when the legacy flag disagrees',
    (speed) => {
      const { result } = renderHook(() => ({
        sending: useMessageSending(
          messageSendingArgs({
            selectedAgentId: 'stored-speed-agent',
            agentDetail: {
              agent_id: 'stored-speed-agent',
              speed,
              fast_mode_cache_enabled: speed === 'standard',
            } as never,
          }),
        ),
        ultra: useUltraPreferred(mocks.authState.user.id),
      }));
      expect(result.current.sending.fastMode).toBe(speed !== 'standard');
      if (speed !== 'standard') expect(result.current.ultra).toBe(speed === 'ultrafast');
    },
  );

  it('hydrates Fast Mode from the loaded agent detail instead of the account default', async () => {
    const agentDetail = {
      agent_id: 'agent-loaded',
      model: 'rose-labs/rose-1-flash',
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
