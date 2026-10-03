import { useEffect } from 'react';

import {
  DISCONNECTED_BACKFILL_FAST_POLL_MS,
  DISCONNECTED_BACKFILL_FAST_WINDOW_MS,
  DISCONNECTED_BACKFILL_POLL_MS,
  DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS,
} from '../config';
import { fetchAgentDetail } from '../api';
import { applyAgentBackfill } from './agentBackfill';
import type { RealtimeSubscriptionDeps } from './useRealtimeSubscription';

/** Poll only while the current agent's realtime channel is disconnected. */
export function useDisconnectedAgentBackfill(deps: RealtimeSubscriptionDeps): void {
  useEffect(() => {
    const agentId = deps.selectedAgentId;
    if (!agentId || !deps.canSubscribe) return;
    let cancelled = false;
    let inFlight = false;
    let requestController: AbortController | null = null;
    let requestTimeout: number | null = null;
    let pollTimer: number | null = null;
    const selectedAt = Date.now();
    const isActive = () => !cancelled && deps.selectedAgentIdRef.current === agentId;
    const poll = () => {
      if (!isActive() || deps.channelRef.current || inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      requestController = controller;
      const timeout = new Promise<never>((_resolve, reject) => {
        requestTimeout = window.setTimeout(() => {
          controller.abort();
          reject(new Error('Disconnected backfill request timed out'));
        }, DISCONNECTED_BACKFILL_REQUEST_TIMEOUT_MS);
      });
      void Promise.race([fetchAgentDetail(agentId, controller.signal), timeout])
        .then((data) => {
          if (!isActive() || deps.channelRef.current) return;
          if (data.agent.agent_id !== agentId) return;
          applyAgentBackfill(data, deps.setMessages, deps.setAgent, deps.setIsChatMode, isActive);
        })
        .catch((error: unknown) => {
          if (isActive()) console.error('Disconnected backfill poll failed:', error);
        })
        .finally(() => {
          if (requestTimeout !== null) window.clearTimeout(requestTimeout);
          requestTimeout = null;
          if (requestController === controller) requestController = null;
          inFlight = false;
        });
    };
    const scheduleNextPoll = () => {
      const delay =
        Date.now() - selectedAt < DISCONNECTED_BACKFILL_FAST_WINDOW_MS
          ? DISCONNECTED_BACKFILL_FAST_POLL_MS
          : DISCONNECTED_BACKFILL_POLL_MS;
      pollTimer = window.setTimeout(() => {
        if (cancelled) return;
        poll();
        scheduleNextPoll();
      }, delay);
    };
    scheduleNextPoll();
    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      if (requestTimeout !== null) window.clearTimeout(requestTimeout);
      requestController?.abort();
    };
  }, [
    deps.selectedAgentId,
    deps.canSubscribe,
    deps.selectedAgentIdRef,
    deps.channelRef,
    deps.setMessages,
    deps.setAgent,
    deps.setIsChatMode,
  ]);
}
