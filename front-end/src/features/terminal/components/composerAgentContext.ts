import { createContext, useContext, useMemo, type RefObject } from 'react';
import type { AgentSlice } from '../types';

// Persistent input DOM must not own a historical transcript through JSX props
// or action closures. Its descendants read the current owner through this ref.
export const ComposerAgentContext = createContext<RefObject<AgentSlice | null> | null>(null);

// Create the disposer outside the provider's render scope: that scope also
// contains the transcript supplied to its per-commit synchronization effect.
export function disposeComposerOwner(owner: RefObject<AgentSlice | null>) {
  return () => {
    owner.current = null;
  };
}

function useComposerOwner() {
  const owner = useContext(ComposerAgentContext);
  if (!owner) throw new Error('Composer requires its agent provider');
  return owner;
}

export function useComposerAgent() {
  const owner = useComposerOwner().current;
  if (!owner) throw new Error('Composer requires a current agent');
  return owner;
}

export function useComposerActions() {
  const owner = useComposerOwner();
  const selectedAgentId = owner.current?.selectedAgentId;
  return useMemo(
    () => ({
      onNavigate: (id: string) => owner.current?.handleSelectAgent(id),
      onChange: (value: string) => owner.current?.setMessageInput(value),
      onSubmit: (...args: Parameters<AgentSlice['handleSendMessage']>) => {
        void owner.current?.handleSendMessage(...args);
      },
      onModelChange: (value: string) => owner.current?.setSelectedModel(value),
      onFastModeChange: (value: boolean) => owner.current?.setFastMode(value),
      onSimulatorModeChange: (value: boolean) => owner.current?.setSimulatorMode(value),
      onPendingPriceLimitChange: (value: number) => owner.current?.setPendingPriceLimitCents(value),
      onAgentUpdate: () => {
        if (selectedAgentId) void owner.current?.refreshAgentDetail(selectedAgentId);
      },
      onAgentDelete: () => {
        owner.current?.cleanupAgentState();
        void owner.current?.loadAgents();
      },
      onPause: () => {
        void owner.current?.handlePauseAgent();
      },
    }),
    [owner, selectedAgentId],
  );
}
