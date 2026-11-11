/**
 * STATE MACHINE: useMeetingNotes
 *
 *   [LOADING] --status--> [DISCONNECTED] | [CONNECTED]
 *   [DISCONNECTED] --connect--> [SIGNING_IN]
 *     web:     browser goes to the provider sign-in, returns to the callback page
 *              (MeetingNotesCallback), which completes it and comes back here
 *     desktop: system browser opens the provider; poll status every 3 s until
 *              connected (gives up after 5 min) --> [CONNECTED]
 *   [CONNECTED] polls status every 10 s while a sync runs or history backfills
 *   [CONNECTED] --sync--> re-reads status
 *   [CONNECTED] --disconnect--> [DISCONNECTING] --done--> [DISCONNECTED]
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  disconnectMeetingNotesApi,
  fetchMeetingNotesStatusApi,
  startMeetingNotesSignInApi,
  syncMeetingNotesApi,
  type MeetingNotesStatus,
} from '../api/meetingNotes';
import {
  meetingNotesCallbackPath,
  meetingNotesReturnKey,
  MEETING_NOTES_PUBLIC_ORIGIN,
  type MeetingNotesProvider,
} from '../meetingNotes';

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

export function useMeetingNotes(
  provider: MeetingNotesProvider,
  enabled: boolean,
  onChange?: () => Promise<void> | void,
) {
  const [status, setStatus] = useState<MeetingNotesStatus | null>(null);
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signInPoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlight = useRef<Promise<MeetingNotesStatus | null> | null>(null);

  // One status read at a time; concurrent callers share it, so no read can
  // supersede another and a slow read always lands. `fresh` waits for any read
  // already in flight and then starts a new one (after a sync or disconnect).
  const refresh = useCallback(
    async (fresh = false): Promise<MeetingNotesStatus | null> => {
      if (inFlight.current !== null) {
        if (!fresh) return inFlight.current;
        await inFlight.current;
      }
      const read = (async () => {
        try {
          const next = await fetchMeetingNotesStatusApi(provider);
          setStatus(next);
          return next;
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          return null;
        } finally {
          inFlight.current = null;
        }
      })();
      inFlight.current = read;
      return read;
    },
    [provider],
  );

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
        await refresh(true);
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
      // The provider returns to Rose's callback page, which finishes the sign-in
      // with this user's session. The Mac app signs in through the system
      // browser, so it returns to the public site instead of the app.
      const origin = electron === null ? window.location.origin : MEETING_NOTES_PUBLIC_ORIGIN;
      if (electron === null) {
        sessionStorage.setItem(
          meetingNotesReturnKey(provider),
          window.location.pathname + window.location.search,
        );
      }
      const { authorizeUrl } = await startMeetingNotesSignInApi(
        provider,
        `${origin}${meetingNotesCallbackPath(provider)}`,
      );
      if (electron === null) {
        window.location.href = authorizeUrl;
        return;
      }
      await electron.openExternal(authorizeUrl);
      const startedAt = Date.now();
      const finish = async (signedIn: boolean) => {
        if (signInPoll.current === null) return;
        stopSignInPoll();
        setBusy(null);
        if (signedIn) await onChange?.();
      };
      signInPoll.current = setInterval(() => {
        // The deadline holds even while a status read is still pending.
        if (Date.now() - startedAt > SIGN_IN_TIMEOUT_MS) {
          void finish(false);
          return;
        }
        void refresh().then(async (next) => {
          // An EXPIRED grant still reads as connected; wait for the new one.
          if (next?.connected === true && next.status !== 'EXPIRED') await finish(true);
        });
      }, SIGN_IN_POLL_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }, [provider, refresh, onChange, stopSignInPoll]);

  return {
    status,
    busy,
    error,
    connect,
    sync: () => run('sync', () => syncMeetingNotesApi(provider)),
    disconnect: () => run('disconnect', () => disconnectMeetingNotesApi(provider)),
  };
}
