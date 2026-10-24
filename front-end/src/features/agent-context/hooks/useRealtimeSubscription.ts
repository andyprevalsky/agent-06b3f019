/**
 * Selected-agent realtime subscription.
 *
 *   idle --select--> subscribing --SUBSCRIBED--> live --disconnect--> reconnecting
 *                         ^                       |                      |
 *                         +-------- resubscribe --+---------<------------+
 *
 *   live, INSERT {row}            -> claim id -> apply row (messages, streams, mode)
 *   live, INSERT_DEFERRED {id}    -> GET /agents/:id/messages/:messageId
 *                                    -> same INSERT path (claim id, apply row)
 *   live, fetch fails / times out -> keep live; the next subscribe reconcile reads the snapshot
 */
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
import { notifyOpenAgentActivity, userUiActiveChangedHandler } from '@/lib/openAgentActivity';

import type { StreamingBubble, StreamingPlan, StreamingAttention, StreamingTool } from '../types';
import { createReconnectScheduler } from './agentReconnectScheduler';
import { createCompletionBackfillOwner, type CompletionBackfillLease } from './agentBackfill';
import {
  handleUpdateAgent,
  handleAssistantStream,
  handlePlanStream,
  handleAttentionStream,
  handleToolStream,
  cleanupSubscription,
} from './realtimeHandlers';
import { createInsertHandlers } from './realtimeInsertHandlers';
import { useDisconnectedAgentBackfill } from './useDisconnectedAgentBackfill';
import { useReceivedInserts, type ReceivedInserts } from './useReceivedInserts';
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
  receivedRef: React.MutableRefObject<ReceivedInserts>,
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
  const { onInsert, onInsertDeferred } = createInsertHandlers(
    deps,
    scope.agentId,
    active,
    receivedRef,
    {
      setStreamingBubbles,
      setStreamingPlan,
      setStreamingAttention,
      setStreamingTools,
      setMessages,
      setIsChatMode,
    },
    onBrowserMessage,
  );
  return {
    onInsert,
    onInsertDeferred,
    onUpdate: (updated: UpdateAgentPayload) => {
      if (!active()) return;
      handleUpdateAgent(updated, setAgent, setIsChatMode, deps.onLoadAgents);
      if (updated.status !== undefined) {
        notifyOpenAgentActivity({ agentId: scope.agentId, kind: 'status' });
      }
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
    onUserUiActiveChanged: userUiActiveChangedHandler(active, scope.agentId),
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

async function connectRealtime(
  deps: RealtimeSubscriptionDeps,
  scope: AgentScope,
  scheduleReconnect: () => void,
  leaseRef: React.MutableRefObject<CompletionBackfillLease | null>,
  receivedRef: React.MutableRefObject<ReceivedInserts>,
): Promise<void> {
  const { reconcile, observeBrowserInsert } = createCompletionBackfillOwner(
    {
      ...deps,
      selectedAgentId: scope.agentId,
      isCancelled: () => !isScopeActive(deps, scope),
      isCurrentAgent: () => isAgentScopeCurrent(deps.selectedAgentIdRef, scope),
      leaseRef,
    },
    receivedRef.current.browserMessages,
  );
  try {
    const channel = await subscribeToAgent(
      scope.agentId,
      createRealtimeHandlers(deps, scope, scheduleReconnect, receivedRef, observeBrowserInsert),
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
  receivedRef: React.MutableRefObject<ReceivedInserts>,
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
  void connectRealtime(deps, scope, scheduleReconnect, leaseRef, receivedRef);
  return cleanup;
}

export function useRealtimeSubscription(deps: RealtimeSubscriptionDeps) {
  const leaseRef = useRef<CompletionBackfillLease | null>(null);
  const receivedRef = useReceivedInserts(deps.selectedAgentId);
  const {
    selectedAgentId,
    selectedAgentIdRef,
    canSubscribe,
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
  } = deps;
  useEffect(
    () =>
      startAgentSubscription(
        {
          selectedAgentId,
          selectedAgentIdRef,
          canSubscribe,
          forceResubscribeCounter: deps.forceResubscribeCounter,
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
          onLoadAgents: deps.onLoadAgents,
        },
        leaseRef,
        receivedRef,
      ),
    [
      selectedAgentId,
      canSubscribe,
      deps.forceResubscribeCounter,
      dispatchMessage,
      deps.onLoadAgents,
      receivedRef,
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
