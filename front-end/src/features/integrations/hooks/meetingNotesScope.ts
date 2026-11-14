/** Session-bound request lifetime. Existing auth events supply identity; no polling. */
import { useMemo, useSyncExternalStore } from 'react';
import { AUTH_SESSION_CHANGED_EVENT, getCachedUser, getSession } from '@/lib/supabase';
import type { MeetingNotesProvider, MeetingNotesStatus } from '../types';

function identity() {
  const session = getSession();
  const user = session?.user ?? (session ? getCachedUser() : null);
  return user && !user.is_anonymous ? user.id : null;
}
function sessionObserver() {
  let snapshot = { identity: identity() };
  const read = () => {
    const next = identity();
    if (snapshot.identity !== next) snapshot = { identity: next };
    return snapshot;
  };
  return {
    read,
    subscribe: (changed: () => void) => {
      const notify = () => {
        read();
        changed();
      };
      window.addEventListener(AUTH_SESSION_CHANGED_EVENT, notify);
      window.addEventListener('storage', notify);
      return () => {
        window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, notify);
        window.removeEventListener('storage', notify);
      };
    },
  };
}
export interface MeetingNotesScope {
  provider: MeetingNotesProvider;
  identity: string | null;
  sessionCurrent: () => boolean;
  enabled: boolean;
  active: boolean;
  action: number;
  signInPoll: ReturnType<typeof setInterval> | null;
  inFlight: Promise<MeetingNotesStatus | null> | null;
}
export function useMeetingNotesScope(provider: MeetingNotesProvider, enabled: boolean) {
  const observer = useMemo(sessionObserver, []);
  const session = useSyncExternalStore(observer.subscribe, observer.read, observer.read);
  return useMemo<MeetingNotesScope>(
    () => ({
      provider,
      identity: session.identity,
      sessionCurrent: () => observer.read() === session,
      enabled,
      active: false,
      action: 0,
      signInPoll: null,
      inFlight: null,
    }),
    [provider, enabled, session, observer],
  );
}
export function currentScope(scope: MeetingNotesScope) {
  return scope.active && scope.enabled && scope.identity !== null && scope.sessionCurrent();
}
export function stopSignInPoll(scope: MeetingNotesScope) {
  if (scope.signInPoll !== null) clearInterval(scope.signInPoll);
  scope.signInPoll = null;
}
