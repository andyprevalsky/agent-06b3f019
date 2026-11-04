/**
 * STATE MACHINE: useGranola
 *
 *   [LOADING] --status--> [DISCONNECTED] | [CONNECTED]
 *   [DISCONNECTED] --connect--> [SIGNING_IN]
 *     web:     browser goes to Granola sign-in, returns to the callback page
 *              (GranolaCallback), which completes it and comes back here
 *     desktop: system browser opens Granola; poll status every 3 s until
 *              connected (gives up after 5 min) --> [CONNECTED]
 *   [CONNECTED] polls status every 10 s while a sync runs or history backfills
 *   [CONNECTED] --sync--> re-reads status
 *   [CONNECTED] --disconnect--> [DISCONNECTING] --done--> [DISCONNECTED]
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  disconnectGranolaApi,
  fetchGranolaStatusApi,
  startGranolaSignInApi,
  syncGranolaApi,
  type GranolaStatus,
} from '../api/granola';
import { GRANOLA_CALLBACK_PATH, GRANOLA_PUBLIC_ORIGIN, GRANOLA_RETURN_KEY } from '../config';

const SYNC_POLL_MS = 10_000;
const SIGN_IN_POLL_MS = 3_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

interface ElectronExternalApi {
  openExternal: (url: string) => Promise<unknown>;
}

function electronExternalApi(): ElectronExternalApi | null {
  const candidate: unknown = window.api;
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    'openExternal' in candidate &&
    typeof candidate.openExternal === 'function'
  ) {
    return candidate as ElectronExternalApi;
  }
  return null;
}

export function useGranola(enabled: boolean, onChange?: () => Promise<void> | void) {
  const [status, setStatus] = useState<GranolaStatus | null>(null);
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signInPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestRead = useRef(0);

  // Only the newest status read is applied: an older request that finishes
  // last must not restore a stale status (e.g. EXPIRED after a new sign-in).
  const refresh = useCallback(async () => {
    const read = ++latestRead.current;
    try {
      const next = await fetchGranolaStatusApi();
      if (read !== latestRead.current) return null;
      setStatus(next);
      return next;
    } catch (err) {
      if (read === latestRead.current) setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const syncing =
    // EXPIRED and SYNC_FAILED keep `connected` but make no progress: no poll.
    status?.status === 'SYNCING' || (status?.status === 'CONNECTED' && !status.backfillDone);
  useEffect(() => {
    if (!syncing) return undefined;
    const timer = setInterval(() => void refresh(), SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [syncing, refresh]);

  const stopSignInPoll = useCallback(() => {
    if (signInPoll.current !== null) clearInterval(signInPoll.current);
    signInPoll.current = null;
  }, []);
  useEffect(() => stopSignInPoll, [stopSignInPoll]);

  const run = useCallback(
    async (kind: 'sync' | 'disconnect', action: () => Promise<unknown>) => {
      setBusy(kind);
      setError(null);
      try {
        await action();
        await refresh();
        await onChange?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [refresh, onChange],
  );

  const connect = useCallback(async () => {
    setBusy('connect');
    setError(null);
    stopSignInPoll();
    const electron = electronExternalApi();
    try {
      // Granola returns to Rose's callback page, which finishes the sign-in
      // with this user's session. The Mac app signs in through the system
      // browser, so it returns to the public site instead of the app.
      const origin = electron === null ? window.location.origin : GRANOLA_PUBLIC_ORIGIN;
      if (electron === null) {
        sessionStorage.setItem(
          GRANOLA_RETURN_KEY,
          window.location.pathname + window.location.search,
        );
      }
      const { authorizeUrl } = await startGranolaSignInApi(`${origin}${GRANOLA_CALLBACK_PATH}`);
      if (electron === null) {
        window.location.href = authorizeUrl;
        return;
      }
      await electron.openExternal(authorizeUrl);
      const startedAt = Date.now();
      signInPoll.current = setInterval(() => {
        void (async () => {
          const next = await refresh();
          // An EXPIRED grant still reads as connected; wait for the new one.
          const signedIn = next?.connected === true && next.status !== 'EXPIRED';
          if (signedIn || Date.now() - startedAt > SIGN_IN_TIMEOUT_MS) {
            stopSignInPoll();
            setBusy(null);
            if (signedIn) await onChange?.();
          }
        })();
      }, SIGN_IN_POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }, [refresh, onChange, stopSignInPoll]);

  return {
    status,
    busy,
    error,
    connect,
    sync: () => run('sync', syncGranolaApi),
    disconnect: () => run('disconnect', disconnectGranolaApi),
  };
}
