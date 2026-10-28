/**
 * STATE MACHINE: useGranola
 *
 *   [LOADING] --status--> [DISCONNECTED] | [CONNECTED]
 *   [DISCONNECTED] --connect--> [SIGNING_IN]
 *     web:     browser goes to Granola sign-in, returns to this page connected
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

  const refresh = useCallback(async () => {
    try {
      const next = await fetchGranolaStatusApi();
      setStatus(next);
      return next;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  const syncing =
    status?.status === 'SYNCING' || (status?.connected === true && !status.backfillDone);
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
      const returnUrl =
        electron === null ? window.location.origin + window.location.pathname : undefined;
      const { authorizeUrl } = await startGranolaSignInApi(returnUrl);
      if (electron === null) {
        window.location.href = authorizeUrl;
        return;
      }
      await electron.openExternal(authorizeUrl);
      const startedAt = Date.now();
      signInPoll.current = setInterval(() => {
        void (async () => {
          const next = await refresh();
          if (next?.connected === true || Date.now() - startedAt > SIGN_IN_TIMEOUT_MS) {
            stopSignInPoll();
            setBusy(null);
            if (next?.connected === true) await onChange?.();
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
