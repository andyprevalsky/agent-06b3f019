import { useEffect } from 'react';
import { type RealtimeChannel } from '@supabase/supabase-js';

import { HEALTH_CHECK_INTERVAL_MS } from '../config';

export function useHealthCheck(
  selectedAgentId: string | null,
  canSubscribe: boolean,
  channelRef: React.MutableRefObject<RealtimeChannel | null>,
  isReconnectingRef: React.MutableRefObject<boolean>,
  setForceResubscribeCounter: React.Dispatch<React.SetStateAction<number>>,
) {
  useEffect(() => {
    if (!selectedAgentId || !canSubscribe) return;

    const interval = setInterval(() => {
      const state = channelRef.current?.state;
      const shouldReconnect =
        (!channelRef.current || (state !== 'joined' && state !== 'joining')) &&
        !isReconnectingRef.current;

      if (shouldReconnect) {
        console.warn(
          `[AgentContext] Health check: ${!channelRef.current ? 'no channel' : `state="${state}"`}, triggering reconnect`,
        );
        setForceResubscribeCounter((prev) => prev + 1);
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [selectedAgentId, canSubscribe, channelRef, isReconnectingRef, setForceResubscribeCounter]);
}
