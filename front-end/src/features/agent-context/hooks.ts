import { useCallback, useContext, createContext } from 'react';

import { isBenchmarkArchiveMode } from '@/lib/benchmarkArchive';
import { isBenchmarkSharedView } from '@/lib/benchmarkShare';

import type { AgentContextValue, AgentProviderProps } from './types';
import { benchmarkAgentPreviewEnabled } from './api';
import { useAgentMessaging } from './hooks/useAgentMessaging';
import { useAgentProviderEffects } from './hooks/useAgentProviderEffects';
import { useAgentProviderState } from './hooks/useAgentProviderState';
import { useAgentSelection } from './hooks/useAgentSelection';
import { useUserMessagePickup } from './hooks/optimisticUserMessages';

export const AgentContext = createContext<AgentContextValue | null>(null);

export function useAgentContext(): AgentContextValue {
  const context = useContext(AgentContext);
  if (!context) throw new Error('useAgentContext must be used within AgentProvider');
  return context;
}

type ProviderDeps = Pick<
  AgentProviderProps,
  'user' | 'isAuthenticated' | 'realtimeReady' | 'onLoadAgents'
>;

export function useAgentProvider({
  user,
  isAuthenticated,
  realtimeReady,
  onLoadAgents,
}: ProviderDeps): AgentContextValue {
  const state = useAgentProviderState();
  const canSubscribe = (isAuthenticated ?? !!user) && (realtimeReady ?? false);
  const hasFullAccess = canSubscribe || isBenchmarkArchiveMode();
  const canLoadAgent = hasFullAccess || benchmarkAgentPreviewEnabled() || isBenchmarkSharedView();
  const messaging = useAgentMessaging(state);
  const selection = useAgentSelection(state, { canLoadAgent, hasFullAccess });
  useUserMessagePickup(
    state.selectedAgentId,
    state.streamingBubbles,
    state.messages,
    state.setMessages,
  );
  const { setForceResubscribeCounter } = state;
  const forceResubscribe = useCallback(() => {
    setForceResubscribeCounter((previous) => previous + 1);
  }, [setForceResubscribeCounter]);

  useAgentProviderEffects(state, {
    canSubscribe,
    onLoadAgents,
    dispatchMessage: messaging.dispatchMessage,
    setSelectedAgentId: selection.setSelectedAgentId,
  });

  return {
    agent: state.agent,
    applyAgentDetail: selection.applyAgentDetail,
    inspectionContext: state.inspectionContext,
    selectedAgentId: state.selectedAgentId,
    setSelectedAgentId: selection.setSelectedAgentId,
    stagePendingAgentCreation: selection.stagePendingAgentCreation,
    reconcilePendingAgentCreation: selection.reconcilePendingAgentCreation,
    rollbackPendingAgentCreation: selection.rollbackPendingAgentCreation,
    stageUserMessage: messaging.stageUserMessage,
    messages: state.messages,
    streamingBubbles: state.streamingBubbles,
    streamingPlan: state.streamingPlan,
    streamingAttention: state.streamingAttention,
    streamingTools: state.streamingTools,
    streamedTextsRef: state.streamedTextsRef,
    registerMessageHandler: messaging.registerMessageHandler,
    sendMessage: messaging.sendMessage,
    isLoadingAgent: state.isLoadingAgent,
    forceResubscribe,
    isChatMode: state.isChatMode,
  };
}
