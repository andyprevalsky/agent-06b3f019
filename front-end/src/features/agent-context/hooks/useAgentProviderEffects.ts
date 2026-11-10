import { useEffect } from 'react';

import type { AgentProviderProps } from '../types';
import { useHealthCheck } from './useHealthCheck';
import { usePopstateSync } from './usePopstateSync';
import { useRealtimeSubscription } from './useRealtimeSubscription';
import { useVisibilityReconnect } from './useVisibilityReconnect';
import type { AgentProviderState } from './useAgentProviderState';
import { resetStreamingBubbles } from './realtimeHandlers';

interface EffectOptions {
  canSubscribe: boolean;
  onLoadAgents?: AgentProviderProps['onLoadAgents'];
  dispatchMessage: Parameters<typeof useRealtimeSubscription>[0]['dispatchMessage'];
  setSelectedAgentId: (id: string | null) => void;
}

export function useAgentProviderEffects(state: AgentProviderState, options: EffectOptions) {
  const { agent, setStreamingBubbles, setStreamingPlan, setStreamingTools } = state;
  useRealtimeSubscription({
    selectedAgentId: state.selectedAgentId,
    selectedAgentIdRef: state.selectedAgentIdRef,
    canSubscribe: options.canSubscribe,
    forceResubscribeCounter: state.forceResubscribeCounter,
    channelRef: state.channelRef,
    reconnectAttemptRef: state.reconnectAttemptRef,
    reconnectTimeoutRef: state.reconnectTimeoutRef,
    isReconnectingRef: state.isReconnectingRef,
    initialLoadDoneRef: state.initialLoadDoneRef,
    streamedTextsRef: state.streamedTextsRef,
    completedStreamIdsRef: state.completedStreamIdsRef,
    setStreamingBubbles: state.setStreamingBubbles,
    setStreamingPlan: state.setStreamingPlan,
    setStreamingAttention: state.setStreamingAttention,
    setStreamingTools: state.setStreamingTools,
    setMessages: state.setMessages,
    setAgent: state.setAgent,
    setIsChatMode: state.setIsChatMode,
    setForceResubscribeCounter: state.setForceResubscribeCounter,
    dispatchMessage: options.dispatchMessage,
    onLoadAgents: options.onLoadAgents,
  });

  useVisibilityReconnect(state.selectedAgentId, state.channelRef, state.setForceResubscribeCounter);
  useHealthCheck(
    state.selectedAgentId,
    options.canSubscribe,
    state.channelRef,
    state.isReconnectingRef,
    state.setForceResubscribeCounter,
  );
  usePopstateSync(state.selectedAgentId, options.setSelectedAgentId);

  useEffect(() => {
    if (agent?.status !== 'PAUSED') return;
    resetStreamingBubbles(setStreamingBubbles);
    setStreamingPlan(null);
    setStreamingTools(new Map());
  }, [agent?.status, setStreamingBubbles, setStreamingPlan, setStreamingTools]);
}
