/** Focus/visible -> one delayed reconnect; joined/hidden/switch/unmount -> cancel. */
import { useEffect } from 'react';
import { type RealtimeChannel } from '@supabase/supabase-js';

import { VISIBILITY_RECONNECT_DELAY_MS, FOCUS_RECONNECT_DELAY_MS } from '../config';

export function useVisibilityReconnect(
  selectedAgentId: string | null,
  channelRef: React.MutableRefObject<RealtimeChannel | null>,
  setForceResubscribeCounter: React.Dispatch<React.SetStateAction<number>>,
) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleReconnect = (delay: number) => {
      if (!selectedAgentId || channelRef.current?.state === 'joined' || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (!document.hidden && channelRef.current?.state !== 'joined') {
          setForceResubscribeCounter((prev) => prev + 1);
        }
      }, delay);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        clearTimeout(timer);
        timer = undefined;
      } else {
        scheduleReconnect(VISIBILITY_RECONNECT_DELAY_MS);
      }
    };

    const handleFocus = () => {
      scheduleReconnect(FOCUS_RECONNECT_DELAY_MS);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [selectedAgentId, channelRef, setForceResubscribeCounter]);
}
