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
import { MAX_RECONNECT_DELAY_MS, DISCONNECTED_BACKFILL_POLL_MS } from '../config';
import { fetchAgentDetail } from '../api';
import { applyAgentBackfill, runPostSubscribeBackfill } from './agentBackfill';
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
      if (cancelled || !selectedAgentId || !canSubscribe) return;

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

      // Use globalThis so a pending Node timer cannot throw if jsdom already
      // tore down `window` between schedule and fire (vitest file teardown).
      // Keep the timer ID local so a stale callback from a previous effect
      // cannot clear a newer effect's reconnectTimeoutRef.
      const timeoutId = globalThis.setTimeout(() => {
        if (reconnectTimeoutRef.current !== timeoutId) return;
        reconnectTimeoutRef.current = null;
        // Effect cleanup sets cancelled and clears this timer; still guard in
        // case the callback is already queued when the environment is destroyed.
        if (cancelled || typeof globalThis.window === 'undefined') return;
        setForceResubscribeCounter((prev) => prev + 1);
      }, delay) as unknown as number;
      reconnectTimeoutRef.current = timeoutId;
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

        // Reconcile immediately after EVERY successful (re)subscribe — cold-start
        // included. During the subscribe/auth-race window (a fresh
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
        // A successful snapshot is not enough to stop when the latest user turn
        // is still incomplete: a connected Supabase channel can lose one later
        // broadcast, and realtime does not replay it. Continue a short bounded
        // reconcile burst until the canonical final answer is present (or the
        // turn enters Temporal agent mode). This also keeps transient fetch
        // failures bounded independently from successful incomplete snapshots.
        // `cancelled` is set on agent change, unmount, or resubscribe, so every
        // attempt (and the delay between them) short-circuits to a no-op once
        // this subscription is torn down — no timer outlives the effect.
        await runPostSubscribeBackfill({
          selectedAgentId,
          isCancelled: () => cancelled,
          initialLoadDoneRef,
          setMessages,
          setAgent,
          setIsChatMode,
        });
      } catch (error) {
        console.error('Failed to subscribe:', error);
        if (cancelled) return;
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
