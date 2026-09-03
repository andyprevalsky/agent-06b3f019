import { useEffect } from 'react';

import { DISCONNECTED_BACKFILL_POLL_MS } from '../config';
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
    const isActive = () => !cancelled && deps.selectedAgentIdRef.current === agentId;
    const interval = window.setInterval(() => {
      if (!isActive() || deps.channelRef.current || inFlight) return;
      inFlight = true;
      void fetchAgentDetail(agentId)
        .then((data) => {
          if (!isActive() || deps.channelRef.current) return;
          applyAgentBackfill(data, deps.setMessages, deps.setAgent, deps.setIsChatMode, isActive);
        })
        .catch((error: unknown) => {
          if (isActive()) console.error('Disconnected backfill poll failed:', error);
        })
        .finally(() => {
          inFlight = false;
        });
    }, DISCONNECTED_BACKFILL_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
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
