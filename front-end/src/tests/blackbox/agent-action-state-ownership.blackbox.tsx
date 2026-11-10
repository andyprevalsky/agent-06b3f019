import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  useAgentProviderState,
  type AgentProviderState,
} from '@/features/agent-context/hooks/useAgentProviderState';
import { useAgentSelection } from '@/features/agent-context/hooks/useAgentSelection';
import { useAgentMessaging } from '@/features/agent-context/hooks/useAgentMessaging';

function retiredState() {
  const owner = renderHook(() => useAgentProviderState());
  const first: AgentProviderState = {
    ...owner.result.current,
    messages: Array.from({ length: 10000 }, (_, i) => ({
      message_id: `old-${i}`,
      text: 'old history',
      role: 'USER' as const,
      timestamp: '',
    })),
  };
  return { owner, retired: Proxy.revocable(first, {}) };
}

describe('agent actions keep controls independently of retired trajectory state', () => {
  it.each(['select', 'stage'] as const)(
    'saved %s action releases the original aggregate state',
    (action) => {
      const { owner, retired } = retiredState();
      const { result, rerender } = renderHook(
        ({ state }) => useAgentSelection(state, { canLoadAgent: false, hasFullAccess: false }),
        { initialProps: { state: retired.proxy } },
      );
      const saved = result.current;
      rerender({ state: owner.result.current });
      retired.revoke();
      act(() => {
        if (action === 'select') expect(() => saved.setSelectedAgentId(null)).not.toThrow();
        else
          expect(() =>
            saved.stagePendingAgentCreation({
              agentId: 'new',
              goal: 'New goal',
              model: 'rose-1-ultra',
              source: 'WEB',
              priceLimitCents: 0,
            }),
          ).not.toThrow();
      });
      expect(owner.result.current.selectedAgentIdRef.current).toBe(
        action === 'select' ? null : 'new',
      );
      expect(owner.result.current.messages.map((m) => m.text)).toEqual(
        action === 'select' ? [] : ['New goal'],
      );
    },
  );
  it('saved dispatch and handler cleanup need only the shared handler registry', () => {
    const { owner, retired } = retiredState();
    const { result, rerender } = renderHook(({ state }) => useAgentMessaging(state), {
      initialProps: { state: retired.proxy },
    });
    const handler = vi.fn();
    const saved = result.current;
    const unregister = saved.registerMessageHandler(null, handler);
    rerender({ state: owner.result.current });
    retired.revoke();
    const message = {
      message_id: 'new',
      text: 'Current update',
      role: 'ASSISTANT' as const,
      timestamp: '',
    };
    expect(() => saved.dispatchMessage(message)).not.toThrow();
    expect(handler).toHaveBeenCalledWith(message);
    expect(() => unregister()).not.toThrow();
    expect(owner.result.current.messageHandlersRef.current.size).toBe(0);
  });
});
