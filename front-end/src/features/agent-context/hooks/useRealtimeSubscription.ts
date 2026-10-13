import { useEffect, useRef } from 'react';
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
import { publishBrowserSessionBinding } from '@/lib/browserSessionBindings';

import type { StreamingBubble, StreamingPlan, StreamingAttention, StreamingTool } from '../types';
import { MAX_RECONNECT_DELAY_MS } from '../config';
import { createCompletionBackfillOwner, type CompletionBackfillLease } from './agentBackfill';
import {
  handleInsertMessage,
  handleUpdateAgent,
  handleAssistantStream,
  handlePlanStream,
  handleAttentionStream,
  handleToolStream,
  cleanupSubscription,
} from './realtimeHandlers';
import { useDisconnectedAgentBackfill } from './useDisconnectedAgentBackfill';
import { endsCloudAgentMode, startsCloudAgentMode } from './cloudAgentMode';
import {
  isAgentScopeActive,
  isAgentScopeCurrent,
  scopedSetter,
  type AgentScope,
} from './agentScope';

export interface RealtimeSubscriptionDeps {
  selectedAgentId: string | null;
  selectedAgentIdRef: React.MutableRefObject<string | null>;
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

type AgentHandlers = Parameters<typeof subscribeToAgent>[1];

function isScopeActive(deps: RealtimeSubscriptionDeps, scope: AgentScope): boolean {
  return isAgentScopeActive(deps.selectedAgentIdRef, scope, 'realtime-subscription');
}

function createRealtimeHandlers(
  deps: RealtimeSubscriptionDeps,
  scope: AgentScope,
  scheduleReconnect: () => void,
  onBrowserMessage: (message: InsertMessagePayload) => void,
): AgentHandlers {
  const active = () => isScopeActive(deps, scope);
  const current = () => isAgentScopeCurrent(deps.selectedAgentIdRef, scope);
  const setStreamingBubbles = scopedSetter(deps.setStreamingBubbles, active, current);
  const setStreamingPlan = scopedSetter(deps.setStreamingPlan, active, current);
  const setStreamingAttention = scopedSetter(deps.setStreamingAttention, active, current);
  const setStreamingTools = scopedSetter(deps.setStreamingTools, active, current);
  const setMessages = scopedSetter(deps.setMessages, active, current);
  const setAgent = scopedSetter(deps.setAgent, active, current);
  const setIsChatMode = scopedSetter(deps.setIsChatMode, active, current);
  return {
    onInsert: (data: InsertMessagePayload) => {
      if (!active()) return;
      if (startsCloudAgentMode(data, scope.agentId)) setIsChatMode(false);
      if (endsCloudAgentMode(data, scope.agentId)) setIsChatMode(true);
      handleInsertMessage(data, scope.agentId, {
        ...deps,
        setStreamingBubbles,
        setStreamingPlan,
        setStreamingAttention,
        setStreamingTools,
        setMessages,
        dispatchMessage: (message) => {
          if (active()) deps.dispatchMessage(message);
        },
      });
      if (data.agentId === scope.agentId && data.metadata?.toolName === 'spawn_browser_agent') {
        onBrowserMessage(data);
      }
    },
    onUpdate: (updated: UpdateAgentPayload) => {
      if (!active()) return;
      handleUpdateAgent(updated, setAgent, setIsChatMode, deps.onLoadAgents);
    },
    onAssistantStream: (chunk: AssistantStreamPayload) => {
      if (!active()) return;
      handleAssistantStream(
        chunk,
        scope.agentId,
        deps.streamedTextsRef,
        setStreamingBubbles,
        deps.completedStreamIdsRef,
        active,
      );
    },
    onPlanStream: (plan: PlanStreamPayload) => {
      if (active()) handlePlanStream(plan, scope.agentId, setStreamingPlan);
    },
    onAttentionStream: (attention: AttentionStreamPayload) => {
      if (active()) handleAttentionStream(attention, scope.agentId, setStreamingAttention);
    },
    onToolStream: (tool: ToolStreamPayload) => {
      if (active()) handleToolStream(tool, scope.agentId, setStreamingTools);
    },
    onAgentModeStarted: (data) => {
      if (active() && data.agentId === scope.agentId) setIsChatMode(false);
    },
    // Live views follow the backend binding, not the lagging transcript URL.
    onBrowserSession: (binding) => {
      if (active()) publishBrowserSessionBinding(binding);
    },
    onDisconnect: () => {
      if (!active()) return;
      console.warn('AgentContext: Channel disconnected, scheduling reconnect');
      scheduleReconnect();
    },
  };
}

function createReconnectScheduler(deps: RealtimeSubscriptionDeps, scope: AgentScope): () => void {
  return () => {
    if (!isScopeActive(deps, scope) || !deps.canSubscribe) return;
    if (deps.reconnectTimeoutRef.current) clearTimeout(deps.reconnectTimeoutRef.current);
    const attempt = deps.reconnectAttemptRef.current;
    deps.reconnectAttemptRef.current += 1;
    const backoff = attempt === 0 ? 0 : Math.min(1000 * 2 ** (attempt - 1), MAX_RECONNECT_DELAY_MS);
    const delay = backoff === 0 ? 0 : backoff + Math.floor(Math.random() * 250);
    const timeoutId = globalThis.setTimeout(() => {
      if (deps.reconnectTimeoutRef.current !== timeoutId) return;
      deps.reconnectTimeoutRef.current = null;
      if (!isScopeActive(deps, scope) || typeof globalThis.window === 'undefined') return;
      deps.setForceResubscribeCounter((previous) =>
        isAgentScopeCurrent(deps.selectedAgentIdRef, scope) ? previous + 1 : previous,
      );
    }, delay) as unknown as number;
    deps.reconnectTimeoutRef.current = timeoutId;
  };
}

async function connectRealtime(
  deps: RealtimeSubscriptionDeps,
  scope: AgentScope,
  scheduleReconnect: () => void,
  leaseRef: React.MutableRefObject<CompletionBackfillLease | null>,
): Promise<void> {
  const { reconcile, observeBrowserInsert } = createCompletionBackfillOwner({
    ...deps,
    selectedAgentId: scope.agentId,
    isCancelled: () => !isScopeActive(deps, scope),
    isCurrentAgent: () => isAgentScopeCurrent(deps.selectedAgentIdRef, scope),
    leaseRef,
  });
  try {
    const channel = await subscribeToAgent(
      scope.agentId,
      createRealtimeHandlers(deps, scope, scheduleReconnect, observeBrowserInsert),
    );
    if (!isScopeActive(deps, scope)) {
      unsubscribe(channel);
      return;
    }
    deps.channelRef.current = channel;
    deps.reconnectAttemptRef.current = 0;
    deps.isReconnectingRef.current = false;
    await reconcile();
  } catch (error) {
    if (!isScopeActive(deps, scope)) return;
    console.error('Failed to subscribe:', error);
    deps.isReconnectingRef.current = false;
    scheduleReconnect();
  }
}

function startAgentSubscription(
  deps: RealtimeSubscriptionDeps,
  leaseRef: React.MutableRefObject<CompletionBackfillLease | null>,
): () => void {
  const scope: AgentScope = {
    agentId: deps.selectedAgentId ?? '',
    cancelled: false,
    discardReported: false,
  };
  const cleanup = () => {
    scope.cancelled = true;
    console.warn('AgentContext: cleanup running');
    cleanupSubscription(
      deps.isReconnectingRef,
      deps.reconnectTimeoutRef,
      deps.channelRef,
      deps.setStreamingBubbles,
      deps.setStreamingPlan,
      deps.setStreamingAttention,
      deps.setStreamingTools,
    );
  };
  if (!deps.selectedAgentId || !deps.canSubscribe) {
    cleanup();
    return cleanup;
  }
  if (deps.isReconnectingRef.current) return cleanup;
  deps.isReconnectingRef.current = true;
  if (deps.channelRef.current) unsubscribe(deps.channelRef.current);
  deps.channelRef.current = null;
  if (deps.reconnectTimeoutRef.current) clearTimeout(deps.reconnectTimeoutRef.current);
  deps.reconnectTimeoutRef.current = null;
  const scheduleReconnect = createReconnectScheduler(deps, scope);
  void connectRealtime(deps, scope, scheduleReconnect, leaseRef);
  return cleanup;
}

export function useRealtimeSubscription(deps: RealtimeSubscriptionDeps) {
  const leaseRef = useRef<CompletionBackfillLease | null>(null);
  const {
    selectedAgentId,
    selectedAgentIdRef,
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
  useEffect(
    () =>
      startAgentSubscription(
        {
          selectedAgentId,
          selectedAgentIdRef,
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
        },
        leaseRef,
      ),
    [
      selectedAgentId,
      canSubscribe,
      forceResubscribeCounter,
      dispatchMessage,
      onLoadAgents,
      selectedAgentIdRef,
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
    ],
  );
  useDisconnectedAgentBackfill(deps);
}
