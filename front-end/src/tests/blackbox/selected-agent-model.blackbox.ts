import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSelectedAgentModel } from '@/features/terminal/hooks/useTerminalAgents';

describe('selected agent model ownership', () => {
  it('resets to the neutral default when the next agent has no model', () => {
    const setSelectedModel = vi.fn();
    const isInitialLoadRef = { current: false };
    const initialProps = {
      selectedAgentId: 'agent-a' as string | null,
      modelOwnerId: 'agent-a' as string | undefined,
      model: 'rose-1-lite' as string | undefined,
    };
    const { rerender } = renderHook(
      ({ selectedAgentId, modelOwnerId, model }) =>
        useSelectedAgentModel(
          selectedAgentId,
          modelOwnerId,
          model,
          setSelectedModel,
          isInitialLoadRef,
        ),
      { initialProps },
    );
    expect(setSelectedModel).toHaveBeenLastCalledWith('rose-1-lite');

    rerender({ selectedAgentId: 'agent-b', modelOwnerId: 'agent-b', model: undefined });

    expect(setSelectedModel).toHaveBeenLastCalledWith('rose-labs/rose-1-ultra');
    expect(isInitialLoadRef.current).toBe(true);

    setSelectedModel.mockClear();
    rerender({ selectedAgentId: 'agent-c', modelOwnerId: 'agent-c', model: undefined });
    expect(setSelectedModel).toHaveBeenLastCalledWith('rose-labs/rose-1-ultra');
  });
});
