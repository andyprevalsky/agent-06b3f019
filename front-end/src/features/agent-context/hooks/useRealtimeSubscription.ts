import { useEffect } from 'react';
import { type RealtimeChannel } from '@supabase/supabase-js';
import {
  subscribeToAgent,
  unsubscribe,
  type InsertMessagePayload,
  type UpdateAgentPayload,
  type AssistantStreamPayload,
  type PlanStreamPayload,
  type AttentionStreamPayload,
  type ToolStreamPayload,
} from '@/lib/realtime';
import type { AgentDetail, Message } from '@/lib/api';

import type { StreamingBubble, StreamingPlan, StreamingAttention, StreamingTool } from '../types';
import { MAX_RECONNECT_DELAY_MS } from '../config';
import { fetchAgentDetail } from '../api';
import {
  handleInsertMessage,
  handleUpdateAgent,
  handleAssistantStream,
  handlePlanStream,
  handleAttentionStream,
  handleToolStream,
  cleanupSubscription,
} from './realtimeHandlers';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RealtimeSubscriptionDeps {
  selectedAgentId: string | null;
  canSubscribe: boolean;
  forceResubscribeCounter: number;
  channelRef: React.MutableRefObject<RealtimeChannel | null>;
  reconnectAttemptRef: React.MutableRefObject<number>;
  reconnectTimeoutRef: React.MutableRefObject<number | null>;
  isReconnectingRef: React.MutableRefObject<boolean>;
  initialLoadDoneRef: React.MutableRefObject<string | null>;
  streamedTextsRef: React.MutableRefObject<Set<string>>;
  completedStreamIdsRef: React.MutableRefObject<Set<string>>;
  setStreamingBubbles: React.Dispatch<React.SetStateAction<Map<string, StreamingBubble>>>;
  setStreamingPlan: React.Dispatch<React.SetStateAction<StreamingPlan | null>>;
  setStreamingAttention: React.Dispatch<React.SetStateAction<StreamingAttention | null>>;
  setStreamingTools: React.Dispatch<React.SetStateAction<Map<string, StreamingTool>>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setAgent: React.Dispatch<React.SetStateAction<AgentDetail | null>>;
  setIsChatMode: React.Dispatch<React.SetStateAction<boolean>>;
  setForceResubscribeCounter: React.Dispatch<React.SetStateAction<number>>;
  dispatchMessage: (message: Message) => void;
  onLoadAgents?: () => void;
}

function startsCloudAgentMode(data: InsertMessagePayload, selectedAgentId: string): boolean {
  const metadata = data.metadata;
  return (
    data.agentId === selectedAgentId &&
    metadata?.toolName === 'cloud_agent' &&
    metadata.toolStatus === 'IN_PROGRESS' &&
    (metadata.startPhase === 'plan' || metadata.startPhase === 'execute')
  );
}

// ─── Main subscription hook ─────────────────────────────────────────────────

// eslint-disable-next-line max-lines-per-function
export function useRealtimeSubscription(deps: RealtimeSubscriptionDeps) {
  const {
    selectedAgentId,
    canSubscribe,
    forceResubscribeCounter,
    channelRef,
    reconnectAttemptRef,
    reconnectTimeoutRef,
    isReconnectingRef,
    initialLoadDoneRef,
    streamedTextsRef,
    completedStreamIdsRef,
    setStreamingBubbles,
    setStreamingPlan,
    setStreamingAttention,
    setStreamingTools,
    setMessages,
    setAgent,
    setIsChatMode,
    setForceResubscribeCounter,
    dispatchMessage,
    onLoadAgents,
  } = deps;

  // eslint-disable-next-line max-lines-per-function
  useEffect(() => {
    let cancelled = false;

    const cleanup = () => {
      cancelled = true;
      console.warn('AgentContext: cleanup running');
      cleanupSubscription(
        isReconnectingRef,
        reconnectTimeoutRef,
        channelRef,
        setStreamingBubbles,
        setStreamingPlan,
        setStreamingAttention,
        setStreamingTools,
      );
    };

    if (!selectedAgentId || !canSubscribe) {
      cleanup();
      return cleanup;
    }

    if (isReconnectingRef.current) {
      console.warn('AgentContext: Reconnection already in progress');
      return cleanup;
    }

    isReconnectingRef.current = true;

    if (channelRef.current) {
      unsubscribe(channelRef.current);
      channelRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const scheduleReconnect = () => {
      if (!selectedAgentId || !canSubscribe) return;

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(1000 * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
      reconnectAttemptRef.current += 1;

      reconnectTimeoutRef.current = window.setTimeout(() => {
        setForceResubscribeCounter((prev) => prev + 1);
      }, delay);
    };

    const setupRealtime = async () => {
      try {
        const channel = await subscribeToAgent(selectedAgentId, {
          onInsert: (data: InsertMessagePayload) => {
            if (startsCloudAgentMode(data, selectedAgentId)) {
              // The router has committed to agent mode and the backend starts
              // Temporal immediately after persisting this message. Transition
              // from chat now; AGENT_MODE_STARTED remains the confirmation and
              // reconnect fallback if this insert was missed.
              setIsChatMode(false);
            }
            handleInsertMessage(data, selectedAgentId, {
              setStreamingBubbles,
              setStreamingPlan,
              setStreamingAttention,
              setStreamingTools,
              setMessages,
              dispatchMessage,
            });
          },
          onUpdate: (updated: UpdateAgentPayload) => {
            handleUpdateAgent(updated, setAgent, setIsChatMode, onLoadAgents);
          },
          onAssistantStream: (chunk: AssistantStreamPayload) => {
            handleAssistantStream(
              chunk,
              selectedAgentId,
              streamedTextsRef,
              setStreamingBubbles,
              completedStreamIdsRef,
            );
          },
          onPlanStream: (plan: PlanStreamPayload) => {
            handlePlanStream(plan, selectedAgentId, setStreamingPlan);
          },
          onAttentionStream: (attention: AttentionStreamPayload) => {
            handleAttentionStream(attention, selectedAgentId, setStreamingAttention);
          },
          onToolStream: (tool: ToolStreamPayload) => {
            handleToolStream(tool, selectedAgentId, setStreamingTools);
          },
          onAgentModeStarted: (data) => {
            if (data.agentId !== selectedAgentId) return;
            setIsChatMode(false);
          },
          onDisconnect: () => {
            console.warn('AgentContext: Channel disconnected, scheduling reconnect');
            if (!cancelled) scheduleReconnect();
          },
        });

        if (cancelled) {
          unsubscribe(channel);
          return;
        }

        channelRef.current = channel;
        reconnectAttemptRef.current = 0;
        isReconnectingRef.current = false;

        const isReconnection = initialLoadDoneRef.current === selectedAgentId;
        if (isReconnection && forceResubscribeCounter > 0) {
          try {
            const data = await fetchAgentDetail(selectedAgentId);
            if (cancelled) return;
            setMessages((prev) => {
              const apiIds = new Set(data.messages.map((m) => m.message_id));
              const realtimeOnly = prev.filter((m) => !apiIds.has(m.message_id));
              return [...data.messages, ...realtimeOnly];
            });
            setAgent(data.agent);
            setIsChatMode(!data.agent.temporal_workflow_id);
          } catch (error) {
            console.error('Failed to refetch after reconnection:', error);
          }
        }
      } catch (error) {
        console.error('Failed to subscribe:', error);
        isReconnectingRef.current = false;
        scheduleReconnect();
      }
    };

    void setupRealtime();
    return cleanup;
  }, [
    selectedAgentId,
    canSubscribe,
    forceResubscribeCounter,
    dispatchMessage,
    onLoadAgents,
    channelRef,
    reconnectAttemptRef,
    reconnectTimeoutRef,
    isReconnectingRef,
    initialLoadDoneRef,
    streamedTextsRef,
    completedStreamIdsRef,
    setStreamingBubbles,
    setStreamingPlan,
    setStreamingAttention,
    setStreamingTools,
    setMessages,
    setAgent,
    setIsChatMode,
    setForceResubscribeCounter,
  ]);
}
