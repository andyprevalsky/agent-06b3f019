/**
 * Auth state actions shared by useAuth: invite-gate evaluation, session
 * application, refresh, and sign-out.
 *
 * STATE FLOW
 *
 *   session read
 *       -> apply identity/cache
 *       -> realtime auth succeeds ------> realtimeReady=true
 *       -> realtime auth fails ---------> realtimeReady=false, continue
 *       -> evaluate invite/operator gate
 *
 * Realtime is one capability, not the owner of the auth state machine. A
 * transient socket-auth failure must not strand a valid HTTP session in a
 * half-applied state or skip the invite/operator decision.
 *
 * Extracted from features/auth/hooks.ts to keep that file inside its max-lines
 * budget. These four callbacks are one cohesive unit — every one of them writes
 * the same four state setters — so they move together rather than being split.
 */

import { useCallback, useRef } from 'react';
import type { User, Session } from '@supabase/supabase-js';

import { checkNeedsInviteCode } from '@/lib/api';
import { getImpersonatedAccount } from '@/lib/impersonation';
import {
  clearSession,
  createAnonymousSession,
  getSession,
  isAnonymousUser,
  persistCachedUser,
  setRealtimeAuth,
} from '@/lib/supabase';

import { logAuth } from './initAuthSession';

interface AuthStateSetters {
  setUser: React.Dispatch<React.SetStateAction<User | null>>;
  setSession: React.Dispatch<React.SetStateAction<Session | null>>;
  setIsFullySignedIn: React.Dispatch<React.SetStateAction<boolean>>;
  /** True only once the invite check actually answered "needs an invite code". */
  setInviteRequired: React.Dispatch<React.SetStateAction<boolean>>;
  setRealtimeReady: React.Dispatch<React.SetStateAction<boolean>>;
}

/** Memoized auth actions: updateInviteStatus, applySession, refreshAuthState, signOut. */
export function useAuthActions(setters: AuthStateSetters) {
  const { setUser, setSession, setIsFullySignedIn, setInviteRequired, setRealtimeReady } = setters;
  // Generation counter for invite checks. checkNeedsInviteCode() is async, so an
  // EARLIER call can resolve after a later one and write a stale answer. That is
  // not hypothetical here: an invite check started before a switch would resolve
  // afterwards and set isFullySignedIn(false), re-trapping the impersonating
  // admin the fix below is meant to free.
  const inviteStatusRequest = useRef(0);

  const updateInviteStatus = useCallback(
    async (currentSession: Session | null, currentUser: User | null) => {
      const request = ++inviteStatusRequest.current;
      if (!currentSession || isAnonymousUser(currentUser)) {
        setIsFullySignedIn(false);
        setInviteRequired(false);
        return;
      }
      // The invite gate asks "has THIS account redeemed a code?" — a question
      // about signup, not about authorization. While an admin is impersonating,
      // the answer belongs to the account being inspected, but the person using
      // the app is an authorized operator. Letting the target's answer win is
      // what stranded admins: isFullySignedIn gates message sending
      // (useMessageSending), goal submission (useTerminalAgents), and the user
      // object the Terminal renders with — so switching into any not-yet-invited
      // account produced a blacked-out waitlist modal, no usable terminal, and no
      // way to act as the account that was just switched into.
      if (getImpersonatedAccount() !== null) {
        setIsFullySignedIn(true);
        setInviteRequired(false);
        logAuth('Invite check skipped: impersonating');
        return;
      }
      try {
        const needsInvite = await checkNeedsInviteCode();
        if (request !== inviteStatusRequest.current) return;
        setIsFullySignedIn(!needsInvite);
        setInviteRequired(needsInvite);
        logAuth('Invite check result', { needsInvite, isFullySignedIn: !needsInvite });
      } catch (error) {
        if (request !== inviteStatusRequest.current) return;
        console.error('[Auth] Failed to check invite requirement', error);
        setIsFullySignedIn(false);
      }
    },
    [setIsFullySignedIn, setInviteRequired],
  );

  const applySession = useCallback(
    async (origin: string, nextSession: Session | null) => {
      logAuth(`Applying session (${origin})`, {
        hasSession: !!nextSession,
        isAnonymous: nextSession?.user?.is_anonymous,
      });
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      persistCachedUser(nextSession?.user ?? null);
      try {
        await setRealtimeAuth(nextSession?.access_token ?? null);
        setRealtimeReady(Boolean(nextSession?.access_token));
      } catch (error) {
        console.error('[Auth] Failed to authenticate realtime session', error);
        setRealtimeReady(false);
      }
      await updateInviteStatus(nextSession, nextSession?.user ?? null);
    },
    [setSession, setUser, setRealtimeReady, updateInviteStatus],
  );

  const refreshAuthState = useCallback(
    async (reason = 'manual-refresh') => {
      logAuth(`refreshAuthState (${reason})`);
      await applySession(reason, getSession());
    },
    [applySession],
  );

  const signOut = useCallback(async () => {
    logAuth('Signing out');
    await clearSession();
    setSession(null);
    setUser(null);
    persistCachedUser(null);
    setIsFullySignedIn(false);
    setInviteRequired(false);
    setRealtimeReady(false);
    await setRealtimeAuth(null);
    try {
      const { session: anonSession } = await createAnonymousSession();
      await applySession('post-signout-anonymous', anonSession);
    } catch (error) {
      console.error('[Auth] Failed to create anonymous session after signout:', error);
    }
  }, [applySession, setSession, setUser, setIsFullySignedIn, setInviteRequired, setRealtimeReady]);

  return { applySession, refreshAuthState, signOut };
}
