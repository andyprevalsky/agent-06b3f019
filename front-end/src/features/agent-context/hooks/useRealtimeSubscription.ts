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
import {
  MAX_RECONNECT_DELAY_MS,
  DISCONNECTED_BACKFILL_POLL_MS,
  BACKFILL_MAX_ATTEMPTS,
  BACKFILL_RETRY_BASE_MS,
} from '../config';
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

/**
 * Reconcile local state from an authoritative agent-detail fetch: API messages
 * are the source of truth, with any realtime-only messages (not yet in the API
 * response) preserved. Shared by the reconnect backfill and the disconnected
 * poll so both agree on one merge rule.
 */
function applyAgentBackfill(
  data: AgentDetail,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
  setAgent: React.Dispatch<React.SetStateAction<AgentDetail | null>>,
  setIsChatMode: React.Dispatch<React.SetStateAction<boolean>>,
): void {
  setMessages((prev) => {
    const apiIds = new Set(data.messages.map((m) => m.message_id));
    const realtimeOnly = prev.filter((m) => !apiIds.has(m.message_id));
    // Order by timestamp rather than blindly appending realtime-only messages
    // after the API set — a realtime message that arrived out of band can be
    // chronologically older than the API tail, and appending it would render it
    // below newer messages. localeCompare on the ISO timestamps keeps the merged
    // thread in true chronological order.
    return [...data.messages, ...realtimeOnly].sort((a, b) =>
      (a.timestamp ?? '').localeCompare(b.timestamp ?? ''),
    );
  });
  setAgent(data.agent);
  setIsChatMode(!data.agent.temporal_workflow_id);
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
      reconnectAttemptRef.current += 1;

      // The FIRST reconnect after a drop fires immediately — a transient
      // CHANNEL_ERROR should self-heal without a visible stall (updates only
      // resume, and missed messages are backfilled, once we re-subscribe).
      // Only repeated consecutive failures back off exponentially (with jitter,
      // to avoid all channels retrying in lockstep) so a real outage doesn't
      // hot-loop. reconnectAttemptRef resets to 0 on any successful (re)join.
      const backoff =
        attempt === 0 ? 0 : Math.min(1000 * Math.pow(2, attempt - 1), MAX_RECONNECT_DELAY_MS);
      const delay = backoff === 0 ? 0 : backoff + Math.floor(Math.random() * 250);

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

        // One-shot reconcile immediately after EVERY successful (re)subscribe —
        // cold-start included. During the subscribe/auth-race window (a fresh
        // context's first agent:<id> join races "Unauthorized" for ~1-2s right
        // after agent creation) the backend may already have streamed the answer
        // and persisted its messages; realtime NEVER replays them, so a brand-new
        // agent's first answer would otherwise sit stranded in the DB while the UI
        // stalls on "Thinking". Gating this to reconnections missed exactly that
        // cold-start case. The merge is idempotent, so double-fetching alongside
        // the initial load is harmless. Marks initialLoadDoneRef so downstream
        // effects know this agent has been reconciled at least once — but only
        // AFTER the backfill actually succeeds, so a failed fetch can't falsely
        // mark the agent reconciled (the next resubscribe must retry it).
        //
        // Retry with bounded backoff on failure: the channel is already live at
        // this point, so the disconnected fallback poll (below) skips every tick
        // (it only runs while channelRef.current is null). A single transient
        // fetchAgentDetail failure would therefore strand the auth-race messages
        // this reconcile exists to recover until an unrelated resubscribe fires.
        // `cancelled` is set on agent change, unmount, or resubscribe, so every
        // attempt (and the delay between them) short-circuits to a no-op once
        // this subscription is torn down — no timer outlives the effect.
        for (let attempt = 0; attempt < BACKFILL_MAX_ATTEMPTS; attempt += 1) {
          try {
            const data = await fetchAgentDetail(selectedAgentId);
            if (cancelled) return;
            applyAgentBackfill(data, setMessages, setAgent, setIsChatMode);
            initialLoadDoneRef.current = selectedAgentId;
            break;
          } catch (error) {
            if (cancelled) return;
            console.error(
              `Failed to backfill after subscribe (attempt ${attempt + 1}/${BACKFILL_MAX_ATTEMPTS}):`,
              error,
            );
            if (attempt === BACKFILL_MAX_ATTEMPTS - 1) break;
            const delay = Math.min(BACKFILL_RETRY_BASE_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
            await new Promise((resolve) => setTimeout(resolve, delay));
            if (cancelled) return;
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

  // API backfill fallback while the realtime channel is NOT connected. A rejected
  // or racing agent:<id> private-channel join (e.g. "Unauthorized" right after
  // agent creation) delivers nothing and never replays, so the UI would stall on
  // "Thinking". Poll the authoritative agent detail on a fixed cadence and
  // reconcile, so messages surface within one interval regardless of the realtime
  // auth race. Ticks are a no-op while the channel is live (channelRef set), so
  // the healthy path pays nothing and the reconnect path owns later recovery.
  useEffect(() => {
    if (!selectedAgentId || !canSubscribe) return;
    let cancelled = false;
    // Serialize fetches: skip a tick while one is in flight so a slow response
    // from an earlier tick can never resolve after (and overwrite) a fresher one.
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (cancelled || channelRef.current || inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const data = await fetchAgentDetail(selectedAgentId);
          if (cancelled || channelRef.current) return;
          applyAgentBackfill(data, setMessages, setAgent, setIsChatMode);
        } catch (error) {
          console.error('Disconnected backfill poll failed:', error);
        } finally {
          inFlight = false;
        }
      })();
    }, DISCONNECTED_BACKFILL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedAgentId, canSubscribe, channelRef, setMessages, setAgent, setIsChatMode]);
}
