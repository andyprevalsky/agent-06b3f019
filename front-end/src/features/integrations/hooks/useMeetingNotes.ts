/**
 * STATE MACHINE: useMeetingNotes
 * [DISABLED / USER CHANGED] → clear state, stop polls, invalidate all old reads/actions.
 * [LOADING] --status--> [DISCONNECTED] | [CONNECTED]
 * [DISCONNECTED] --connect--> [SIGNING IN] --callback / desktop poll--> [CONNECTED]
 * [CONNECTED] --sync / backfill--> bounded status polling; EXPIRED stops polling.
 * [CONNECTED] --disconnect--> [DISCONNECTED]
 * Read recovery clears read errors; failed actions remain visible until another action.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  disconnectMeetingNotesApi,
  fetchMeetingNotesStatusApi,
  startMeetingNotesSignInApi,
  syncMeetingNotesApi,
} from '../api/meetingNotes';
import {
  meetingNotesCallbackPath,
  meetingNotesReturnKey,
  MEETING_NOTES_PUBLIC_ORIGIN,
} from '../config';
import type { MeetingNotesProvider, MeetingNotesStatus } from '../types';
import {
  currentScope,
  stopSignInPoll,
  useMeetingNotesScope,
  type MeetingNotesScope,
} from './meetingNotesScope';

const SYNC_POLL_MS = 10_000;
const SIGN_IN_POLL_MS = 3_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function useMeetingNotesState() {
  const [status, setStatus] = useState<MeetingNotesStatus | null>(null);
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  return { status, setStatus, busy, setBusy, readError, setReadError, actionError, setActionError };
}
type State = ReturnType<typeof useMeetingNotesState>;

function useMeetingNotesStatus(
  provider: MeetingNotesProvider,
  scope: MeetingNotesScope,
  state: State,
) {
  const { setStatus, setReadError } = state;
  const refresh = useCallback(
    async (fresh = false): Promise<MeetingNotesStatus | null> => {
      if (!currentScope(scope)) return null;
      if (scope.inFlight !== null) {
        if (!fresh) return scope.inFlight;
        await scope.inFlight;
        if (!currentScope(scope)) return null;
      }
      const read = (async () => {
        try {
          const next = await fetchMeetingNotesStatusApi(provider);
          if (!currentScope(scope)) return null;
          setStatus(next);
          setReadError(null);
          return next;
        } catch (error) {
          if (currentScope(scope)) setReadError(errorText(error));
          return null;
        } finally {
          scope.inFlight = null;
        }
      })();
      scope.inFlight = read;
      return read;
    },
    [provider, scope, setStatus, setReadError],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const syncing =
    state.status?.status === 'SYNCING' ||
    (state.status?.status === 'CONNECTED' && !state.status.backfillDone);
  useEffect(() => {
    if (!syncing || !currentScope(scope)) return;
    const timer = setInterval(() => void refresh(), SYNC_POLL_MS);
    return () => clearInterval(timer);
  }, [scope, syncing, refresh]);
  return refresh;
}
type Refresh = (fresh?: boolean) => Promise<MeetingNotesStatus | null>;

function useMeetingNotesActions(
  scope: MeetingNotesScope,
  state: State,
  refresh: Refresh,
  onChange?: () => Promise<void> | void,
) {
  const { setBusy, setActionError, setReadError } = state;
  return useCallback(
    async (kind: 'sync' | 'disconnect', action: () => Promise<unknown>) => {
      if (!currentScope(scope)) return;
      const actionId = ++scope.action;
      const current = () => currentScope(scope) && scope.action === actionId;
      stopSignInPoll(scope);
      setBusy(kind);
      setActionError(null);
      setReadError(null);
      try {
        await action();
        if (!current()) return;
        await refresh(true);
        if (current()) await onChange?.();
      } catch (error) {
        if (current()) setActionError(errorText(error));
      } finally {
        if (current()) setBusy(null);
      }
    },
    [scope, setBusy, setActionError, setReadError, refresh, onChange],
  );
}

function useMeetingNotesConnect(
  provider: MeetingNotesProvider,
  scope: MeetingNotesScope,
  state: State,
  refresh: Refresh,
  onChange?: () => Promise<void> | void,
) {
  const { setBusy, setActionError, setReadError } = state;
  return useCallback(async () => {
    if (!currentScope(scope)) return;
    const actionId = ++scope.action;
    const current = () => currentScope(scope) && scope.action === actionId;
    stopSignInPoll(scope);
    setBusy('connect');
    setActionError(null);
    setReadError(null);
    const electron = window.api?.openExternal;
    try {
      const origin = electron ? MEETING_NOTES_PUBLIC_ORIGIN : window.location.origin;
      const { authorizeUrl } = await startMeetingNotesSignInApi(
        provider,
        `${origin}${meetingNotesCallbackPath(provider)}`,
      );
      if (!current()) return;
      if (!electron) {
        sessionStorage.setItem(
          meetingNotesReturnKey(provider),
          window.location.pathname + window.location.search,
        );
        window.location.href = authorizeUrl;
        return;
      }
      await electron(authorizeUrl);
      if (!current()) return;
      const startedAt = Date.now();
      const finish = async (signedIn: boolean) => {
        if (!current() || scope.signInPoll === null) return;
        stopSignInPoll(scope);
        setBusy(null);
        if (signedIn) await onChange?.();
      };
      scope.signInPoll = setInterval(() => {
        if (!current()) {
          stopSignInPoll(scope);
          return;
        }
        if (Date.now() - startedAt > SIGN_IN_TIMEOUT_MS) {
          void finish(false);
          return;
        }
        void refresh().then(async (next) => {
          if (next?.connected && next.status !== 'EXPIRED') await finish(true);
        });
      }, SIGN_IN_POLL_MS);
    } catch (error) {
      if (current()) {
        setActionError(errorText(error));
        setBusy(null);
      }
    }
  }, [provider, scope, setBusy, setActionError, setReadError, refresh, onChange]);
}

export function useMeetingNotes(
  provider: MeetingNotesProvider,
  enabled: boolean,
  onChange?: () => Promise<void> | void,
) {
  const scope = useMeetingNotesScope(provider, enabled);
  const state = useMeetingNotesState();
  const { setStatus, setBusy, setReadError, setActionError } = state;
  useLayoutEffect(() => {
    scope.active = true;
    setStatus(null);
    setBusy(null);
    setReadError(null);
    setActionError(null);
    return () => {
      scope.active = false;
      stopSignInPoll(scope);
    };
  }, [scope, setStatus, setBusy, setReadError, setActionError]);
  const refresh = useMeetingNotesStatus(provider, scope, state);
  const run = useMeetingNotesActions(scope, state, refresh, onChange);
  const connect = useMeetingNotesConnect(provider, scope, state, refresh, onChange);
  return {
    status: state.status,
    busy: state.busy,
    error: state.actionError ?? state.readError,
    connect,
    sync: () => run('sync', () => syncMeetingNotesApi(provider)),
    disconnect: () => run('disconnect', () => disconnectMeetingNotesApi(provider)),
  };
}
