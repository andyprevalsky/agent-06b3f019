import type { AgentProviderState } from './useAgentProviderState';

/** Retained actions need state controls, not the transcript or streaming snapshots. */
export function agentSelectionControls({
  channelRef,
  completedStreamIdsRef,
  initialLoadDoneRef,
  isReconnectingRef,
  pendingCreationRef,
  reconnectTimeoutRef,
  selectedAgentIdRef,
  setAgent,
  setInspectionContext,
  setIsChatMode,
  setIsLoadingAgent,
  setMessages,
  setSelectedAgentIdState,
  setStreamingAttention,
  setStreamingBubbles,
  setStreamingPlan,
  setStreamingTools,
  streamedTextsRef,
}: AgentProviderState) {
  return {
    channelRef,
    completedStreamIdsRef,
    initialLoadDoneRef,
    isReconnectingRef,
    pendingCreationRef,
    reconnectTimeoutRef,
    selectedAgentIdRef,
    setAgent,
    setInspectionContext,
    setIsChatMode,
    setIsLoadingAgent,
    setMessages,
    setSelectedAgentIdState,
    setStreamingAttention,
    setStreamingBubbles,
    setStreamingPlan,
    setStreamingTools,
    streamedTextsRef,
  };
}

export type AgentSelectionControls = ReturnType<typeof agentSelectionControls>;
