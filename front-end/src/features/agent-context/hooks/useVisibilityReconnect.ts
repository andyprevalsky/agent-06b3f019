import { useEffect } from 'react';
import { type RealtimeChannel } from '@supabase/supabase-js';

import { VISIBILITY_RECONNECT_DELAY_MS, FOCUS_RECONNECT_DELAY_MS } from '../config';

export function useVisibilityReconnect(
  selectedAgentId: string | null,
  channelRef: React.MutableRefObject<RealtimeChannel | null>,
  setForceResubscribeCounter: React.Dispatch<React.SetStateAction<number>>,
) {
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && selectedAgentId) {
        if (channelRef.current?.state === 'joined') return;
        setTimeout(() => {
          if (selectedAgentId) {
            setForceResubscribeCounter((prev) => prev + 1);
          }
        }, VISIBILITY_RECONNECT_DELAY_MS);
      }
    };

    const handleFocus = () => {
      if (selectedAgentId) {
        if (channelRef.current?.state === 'joined') return;
        setTimeout(() => {
          if (selectedAgentId) {
            setForceResubscribeCounter((prev) => prev + 1);
          }
        }, FOCUS_RECONNECT_DELAY_MS);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [selectedAgentId, channelRef, setForceResubscribeCounter]);
}
