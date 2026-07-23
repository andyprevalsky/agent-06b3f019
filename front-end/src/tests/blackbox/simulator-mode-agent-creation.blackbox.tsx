import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createAgent: vi.fn(async (payload: { agent_id?: string }) => ({ agent_id: payload.agent_id })),
  postMessage: vi.fn(),
  resumeAgent: vi.fn(),
  checkAndRespondToAttention: vi.fn(async () => false),
}));

vi.mock('@/features/terminal/api', () => api);
vi.mock('@amplitude/analytics-browser', () => ({ track: vi.fn() }));

import { useMessageSending } from '@/features/terminal/hooks/useMessageSending';

describe('Simulator mode agent creation', () => {
  it('sends simulate mode when the visible Simulator toggle is on', async () => {
    const { result } = renderHook(() =>
      useMessageSending({
        selectedAgentId: null,
        agentDetail: null,
        canSubmitGoals: true,
        isFullySignedIn: true,
        userId: '1f85ff25-6e29-4c1b-8739-f917bd101a30',
        clientSource: 'MAC_APP',
        setCurrentView: vi.fn(),
        setLoginModalOpen: vi.fn(),
        setIsLoadingNetwork: vi.fn(),
        loadAgents: vi.fn(async () => undefined),
        stagePendingAgentCreation: vi.fn(),
        reconcilePendingAgentCreation: vi.fn(async () => undefined),
        rollbackPendingAgentCreation: vi.fn(() => true),
      }),
    );

    act(() => {
      result.current.setMessageInput('Run this against the world model');
      result.current.setSimulatorMode(true);
    });

    await act(async () => {
      await result.current.handleSendMessage();
    });

    expect(api.createAgent).toHaveBeenCalledOnce();
    expect(api.createAgent.mock.calls[0]?.[0]).toMatchObject({
      source: 'MAC_APP',
      fast_mode_cache_enabled: false,
      world_model_mode: 'simulate',
    });
  });
});
