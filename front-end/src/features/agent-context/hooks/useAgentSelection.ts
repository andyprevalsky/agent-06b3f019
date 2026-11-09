import { reconcileAgent } from '@/lib/progressEstimate';
import { useCallback, useEffect, useRef } from 'react';
import type React from 'react';
import { type RealtimeChannel } from '@supabase/supabase-js';

import { unsubscribe } from '@/lib/realtime';
import type { AgentDetail, AgentDetailResponse, Message } from '@/lib/api';
import { recordAgentScopeDiscard, recordAgentSelection } from '@/lib/agentScopeDiagnostics';

import { fetchAgentDetail } from '../api';
import { isChatCapableAgent, resetStreamingBubbles } from './realtimeHandlers';
import type {
  PendingAgentCreation,
  PendingAgentCreationInput,
  StreamingAttention,
  StreamingPlan,
  StreamingTool,
} from '../types';
import type { AgentProviderState } from './useAgentProviderState';
import { agentSelectionControls, type AgentSelectionControls } from './agentSelectionControls';
import { carryClientUserMessages } from './optimisticUserMessages';

interface SelectionOptions {
  canLoadAgent: boolean;
  hasFullAccess: boolean;
}

/**
 * Selection state machine:
 *
 *   [EMPTY/SELECTED] -- stage optimistic create --> [PENDING PROJECTION]
 *   [PENDING PROJECTION] -- canonical fetch succeeds --> [SELECTED CANONICAL]
 *     (a background refresh: isLoadingAgent stays false, so the composer and
 *     projected transcript stay mounted while the created agent's detail loads)
 *   [PENDING PROJECTION] -- create fails/rollback --> [EMPTY]
 *   [ANY SELECTION] -- select another id --> [LOADING] --> [SELECTED | EMPTY on failure]
 *
 * Every async transition is guarded by selectedAgentIdRef so stale fetches cannot
 * reconcile or roll back a newer selection. One cancellable detail read belongs
 * to each selection; switching or unmounting aborts it. Its signal also fences
 * A -> B -> A responses when the transport finishes despite cancellation.
 */

export function useAgentSelection(source: AgentProviderState, options: SelectionOptions) {
  const state = agentSelectionControls(source);
  const { selectedAgentId } = source;
  const hasAgent = !!source.agent;
  const stateRef = useRef(state);
  stateRef.current = state;
  const detailRequestRef = useRef<{
    agentId: string;
    clearSelectionOnFailure: boolean;
    controller: AbortController;
    promise: Promise<boolean>;
  } | null>(null);
  useEffect(
    () => () => {
      detailRequestRef.current?.controller.abort();
      detailRequestRef.current = null;
    },
    [],
  );
  const {
    initialLoadDoneRef,
    pendingCreationRef,
    selectedAgentIdRef,
    setAgent,
    setIsChatMode,
    setIsLoadingAgent,
    setInspectionContext,
    setMessages,
  } = state;
  const applyAgentDetail = useCallback(
    (agentId: string, data: AgentDetailResponse): boolean => {
      if (data.agent.agent_id !== agentId) {
        throw new Error(
          `Agent detail identity mismatch: requested ${agentId}, received ${data.agent.agent_id}`,
        );
      }
      if (selectedAgentIdRef.current !== agentId) {
        recordAgentScopeDiscard('agent-detail', agentId, selectedAgentIdRef.current);
        return false;
      }

      const isCurrentAgent = () => selectedAgentIdRef.current === agentId;
      const projection =
        pendingCreationRef.current?.agentId === agentId ? pendingCreationRef.current : null;
      setAgent((previous) =>
        isCurrentAgent()
          ? {
              ...data.agent,
              ...reconcileAgent(
                previous?.agent_id === data.agent.agent_id ? previous : undefined,
                data.agent,
              ),
            }
          : previous,
      );
      setInspectionContext((previous) =>
        isCurrentAgent() ? (data.inspection_context ?? null) : previous,
      );
      setMessages((previous) =>
        isCurrentAgent() ? mergeCanonicalMessages(previous, data.messages, projection) : previous,
      );
      setIsChatMode((previous) => (isCurrentAgent() ? isChatCapableAgent(data.agent) : previous));
      return true;
    },
    [
      pendingCreationRef,
      selectedAgentIdRef,
      setAgent,
      setInspectionContext,
      setIsChatMode,
      setMessages,
    ],
  );
  const loadAgentDetail = useCallback(
    (
      agentId: string,
      clearSelectionOnFailure: boolean,
      refreshesStagedAgent = false,
    ): Promise<boolean> => {
      const pending = detailRequestRef.current;
      if (
        pending?.agentId === agentId &&
        pending.clearSelectionOnFailure === clearSelectionOnFailure &&
        !pending.controller.signal.aborted
      ) {
        return pending.promise;
      }
      pending?.controller.abort();
      const controller = new AbortController();
      const request = {
        agentId,
        clearSelectionOnFailure,
        controller,
        promise: Promise.resolve(false),
      };
      detailRequestRef.current = request;
      // A staged creation already shows its projection: refresh it in the
      // background instead of flipping the view to "loading agent details".
      const showsLoading = !refreshesStagedAgent;
      request.promise = (async () => {
        try {
          if (showsLoading) setIsLoadingAgent(true);
          const data = await fetchAgentDetail(agentId, controller.signal);
          if (controller.signal.aborted) return false;
          if (!applyAgentDetail(agentId, data)) return false;
          initialLoadDoneRef.current = agentId;
          return true;
        } catch (error) {
          if (controller.signal.aborted) return false;
          console.error('Failed to load agent:', error);
          if (clearSelectionOnFailure && selectedAgentIdRef.current === agentId) {
            selectedAgentIdRef.current = null;
            prepareSelection(stateRef.current, null);
          }
          return false;
        } finally {
          if (detailRequestRef.current === request) {
            detailRequestRef.current = null;
            if (showsLoading && selectedAgentIdRef.current === agentId) setIsLoadingAgent(false);
          }
        }
      })();
      return request.promise;
    },
    [initialLoadDoneRef, applyAgentDetail, selectedAgentIdRef, setIsLoadingAgent, stateRef],
  );

  useEffect(() => {
    if (selectedAgentId && options.canLoadAgent && !hasAgent) {
      void loadAgentDetail(selectedAgentId, options.hasFullAccess);
    }
  }, [loadAgentDetail, options.canLoadAgent, options.hasFullAccess, hasAgent, selectedAgentId]);

  const setSelectedAgentId = useCallback(
    (id: string | null) => {
      detailRequestRef.current?.controller.abort();
      detailRequestRef.current = null;
      recordAgentSelection(state.selectedAgentIdRef.current, id);
      state.selectedAgentIdRef.current = id;
      if (state.pendingCreationRef.current?.agentId !== id) state.pendingCreationRef.current = null;
      prepareSelection(state, id);
      if (id && options.canLoadAgent) void loadAgentDetail(id, options.hasFullAccess);
    },
    [loadAgentDetail, options.canLoadAgent, options.hasFullAccess, state],
  );

  const stagePendingAgentCreation = useCallback(
    (input: PendingAgentCreationInput) => {
      detailRequestRef.current?.controller.abort();
      detailRequestRef.current = null;
      const projection = buildPendingCreation(input);
      recordAgentSelection(state.selectedAgentIdRef.current, input.agentId);
      state.selectedAgentIdRef.current = input.agentId;
      state.pendingCreationRef.current = projection;
      prepareSelection(state, input.agentId);
      state.setAgent(projection.agent);
      state.setMessages([projection.message]);
      state.setIsLoadingAgent(false);
    },
    [state],
  );

  const reconcilePendingAgentCreation = useCallback(
    async (agentId: string) => {
      if (
        state.selectedAgentIdRef.current !== agentId ||
        state.pendingCreationRef.current?.agentId !== agentId
      ) {
        return;
      }
      const reconciled = await loadAgentDetail(agentId, false, true);
      if (reconciled && state.pendingCreationRef.current?.agentId === agentId) {
        state.pendingCreationRef.current = null;
      }
    },
    [loadAgentDetail, state.pendingCreationRef, state.selectedAgentIdRef],
  );

  const rollbackPendingAgentCreation = useCallback(
    (agentId: string) => {
      if (
        state.selectedAgentIdRef.current !== agentId ||
        state.pendingCreationRef.current?.agentId !== agentId
      ) {
        return false;
      }
      setSelectedAgentId(null);
      return true;
    },
    [setSelectedAgentId, state.pendingCreationRef, state.selectedAgentIdRef],
  );

  return {
    applyAgentDetail,
    setSelectedAgentId,
    stagePendingAgentCreation,
    reconcilePendingAgentCreation,
    rollbackPendingAgentCreation,
  };
}

function buildPendingCreation(input: PendingAgentCreationInput): PendingAgentCreation {
  const now = new Date().toISOString();
  const messageId = `pending-create:${input.agentId}`;
  return {
    agentId: input.agentId,
    goal: input.goal,
    messageId,
    agent: {
      agent_id: input.agentId,
      goal: input.goal,
      model: input.model,
      source: input.source,
      reasoning_effort: 'medium',
      progress: 0,
      status: 'STARTING_UP',
      status_message: null,
      temporal_workflow_id: null,
      token_count: 0,
      tokens_in: 0,
      tokens_out: 0,
      tool_tokens_in: 0,
      tool_tokens_out: 0,
      tool_cost_cents: 0,
      context_size: 0,
      message_count: 1,
      price_limit_cents: input.priceLimitCents,
      tree_cost_cents: 0,
      created_at: now,
      updated_at: now,
      write_lock_enabled: false,
      parent_agent_id: null,
      parent_goal: null,
      verifier: null,
      tools: [],
    },
    message: { message_id: messageId, timestamp: now, text: input.goal, role: 'USER' },
  };
}

function mergeCanonicalMessages(
  previous: Message[],
  canonical: Message[],
  projection: PendingAgentCreation | null,
): Message[] {
  const canonicalIds = new Set(canonical.map((message) => message.message_id));
  const nonProjectedPrevious = previous.filter(
    (message) => message.message_id !== projection?.messageId,
  );
  const canonicalUserTexts = new Set(
    [...canonical, ...nonProjectedPrevious]
      .filter((message) => message.role === 'USER')
      .map((message) => message.text),
  );
  const realtimeOnly = previous.filter((message) => {
    if (canonicalIds.has(message.message_id)) return false;
    if (message.message_id !== projection?.messageId) return true;
    return !canonicalUserTexts.has(message.text);
  });
  return carryClientUserMessages(previous, [...canonical, ...realtimeOnly]);
}

function prepareSelection(state: AgentSelectionControls, id: string | null) {
  syncUrlParam(id);
  killConnections(state.channelRef, state.reconnectTimeoutRef, state.isReconnectingRef);
  flushState(state);
  state.setIsLoadingAgent(id !== null);
  state.setSelectedAgentIdState(id);
}

function syncUrlParam(id: string | null) {
  const url = new URL(window.location.href);
  const previousAgentId = url.searchParams.get('agent-id');
  if (id) {
    url.searchParams.set('agent-id', id);
    if (previousAgentId && previousAgentId !== id) url.searchParams.delete('browser-id');
  } else {
    url.searchParams.delete('agent-id');
    url.searchParams.delete('browser-id');
  }
  window.history.replaceState(window.history.state ?? {}, '', url.toString());
}

function killConnections(
  channelRef: React.MutableRefObject<RealtimeChannel | null>,
  reconnectTimeoutRef: React.MutableRefObject<number | null>,
  isReconnectingRef: React.MutableRefObject<boolean>,
) {
  if (channelRef.current) unsubscribe(channelRef.current);
  channelRef.current = null;
  if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
  reconnectTimeoutRef.current = null;
  isReconnectingRef.current = false;
}

function flushState(state: AgentSelectionControls) {
  state.setMessages([]);
  state.setInspectionContext(null);
  resetStreamingBubbles(state.setStreamingBubbles);
  state.setStreamingPlan(null as StreamingPlan | null);
  state.setStreamingAttention(null as StreamingAttention | null);
  state.setStreamingTools(new Map<string, StreamingTool>());
  state.setAgent(null as AgentDetail | null);
  state.streamedTextsRef.current.clear();
  state.completedStreamIdsRef.current.clear();
  state.initialLoadDoneRef.current = null;
  state.setIsChatMode(true);
}
