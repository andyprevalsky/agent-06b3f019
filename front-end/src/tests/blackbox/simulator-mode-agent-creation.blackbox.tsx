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
import { ADMIN_USER_IDS } from '@/lib/adminAccounts';
import { FAST_MODE_USER_IDS } from '@/lib/fastModeAccounts';

describe('Simulator mode agent creation', () => {
  it.each(ADMIN_USER_IDS)(
    'sends simulate mode for admin account %s when the visible Simulator toggle is on',
    async (userId) => {
      api.createAgent.mockClear();
      const { result } = renderHook(() =>
        useMessageSending({
          selectedAgentId: null,
          agentDetail: null,
          canSubmitGoals: true,
          isFullySignedIn: true,
          userId,
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
      const createPayload = api.createAgent.mock.calls[0]?.[0];
      expect(createPayload).toMatchObject({
        source: 'MAC_APP',
        world_model_mode: 'simulate',
      });
      expect(FAST_MODE_USER_IDS).toContain(userId);
      // Simulator sends standard speed independently of the cache setting.
      expect(createPayload).toMatchObject({ speed: 'standard' });
      expect(createPayload).not.toHaveProperty('fast_mode_cache_enabled');
    },
  );
});
