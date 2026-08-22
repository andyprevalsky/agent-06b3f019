import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchImessageBridgeStatusApi, type ImessageBridgeStatus } from '../api';

/** Matches backend `BRIDGE_FRESHNESS_MS` (45s) with a small buffer for poll jitter. */
const RELAY_POLL_INTERVAL_MS = 15_000;

/**
 * Polls `/api/imessage/bridge/status` while `enabled`.
 * Returns `null` until the first successful fetch completes.
 */
export function useMacAppRelayStatus(enabled: boolean) {
  const [status, setStatus] = useState<ImessageBridgeStatus | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await fetchImessageBridgeStatusApi();
      setStatus(next);
    } catch (error) {
      console.error('[MacAppRelay] Failed to fetch bridge status:', error);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus(null);
      return;
    }

    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, RELAY_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled, refresh]);

  return status;
}
