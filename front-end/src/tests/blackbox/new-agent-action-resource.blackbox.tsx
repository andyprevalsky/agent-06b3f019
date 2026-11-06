import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalAgents } from '@/features/terminal/hooks/useTerminalAgents';

const state = vi.hoisted(() => ({
  messaging: {} as Record<string, unknown>,
  ctx: {} as Record<string, unknown>,
  select: vi.fn(),
}));
vi.mock('@/features/auth', () => ({
  useAuth: () => ({ isFullySignedIn: false, isAnonymous: true, user: null, loading: true }),
}));
vi.mock('@/features/agent-context', () => ({ useAgentContext: () => state.ctx }));
vi.mock('@/features/terminal/hooks/useAgentList', () => ({
  useAgentList: () => ({ agents: [], setAgents: vi.fn() }),
}));
vi.mock('@/features/terminal/hooks/useTerminalModals', () => ({ useTerminalModals: () => ({}) }));
vi.mock('@/features/terminal/hooks/useLoadingNetwork', () => ({ useLoadingNetwork: () => ({}) }));
vi.mock('@/features/terminal/hooks/useAncestors', () => ({ useAncestors: () => [] }));
vi.mock('@/features/terminal/hooks/useTerminalAuth', () => ({
  useTerminalAuth: () => ({ handleLogout: vi.fn() }),
}));
vi.mock('@/features/terminal/hooks/useQuickQuery', () => ({ useQuickQuery: () => {} }));
vi.mock('@/features/terminal/hooks/useAgentOps', () => ({
  useAgentOps: () => ({ actions: {}, messaging: state.messaging }),
}));

function makeMessaging() {
  return {
    setIsSendingMessage: vi.fn(),
    setMessageInput: vi.fn(),
    syncSelectedModel: vi.fn(),
    setNewAgentProjectId: vi.fn(),
    setNewAgentFolderId: vi.fn(),
  };
}

describe('new-agent action resource ownership', () => {
  beforeEach(() => {
    state.select = vi.fn();
    state.ctx = {
      selectedAgentId: 'old',
      agent: null,
      messages: Array.from({ length: 10_000 }, (_, i) => ({ message_id: `old-${i}` })),
      setSelectedAgentId: state.select,
    };
  });
  it.each(['home', 'project'] as const)(
    'the saved %s entry point uses only the required actions after its composite state retires',
    (entry) => {
      const messaging = makeMessaging();
      const retired = Proxy.revocable(messaging, {});
      state.messaging = retired.proxy;
      const view = vi.fn();
      const reset = vi.fn();
      const { result, rerender } = renderHook(() => useTerminalAgents('agents', view, reset));
      const original = result.current;
      state.messaging = makeMessaging();
      state.ctx = { ...state.ctx, selectedAgentId: null, messages: [] };
      rerender();
      retired.revoke();
      act(() => {
        if (entry === 'home') expect(() => original.handleCreateNewAgent()).not.toThrow();
        else
          expect(() => original.handleCreateNewAgentInProject({ id: 'p-1' }, 'f-1')).not.toThrow();
      });
      expect(state.select).toHaveBeenCalledWith(null);
      expect(messaging.setMessageInput).toHaveBeenCalledWith('');
      expect(messaging.setIsSendingMessage).toHaveBeenCalledWith(false);
      expect(reset).toHaveBeenCalledOnce();
      expect(view).toHaveBeenCalledWith('agents');
      expect(messaging.setNewAgentProjectId).toHaveBeenCalledWith(entry === 'home' ? null : 'p-1');
      expect(messaging.setNewAgentFolderId).toHaveBeenCalledWith(entry === 'home' ? null : 'f-1');
    },
  );
});
