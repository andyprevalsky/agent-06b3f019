/**
 * STATE MACHINE: useAuth
 *
 * Simple auth with anonymous fallback.
 * SINGLE SOURCE OF TRUTH for realtime auth - setRealtimeAuth() is called here only.
 *
 * [LOADING] <-- loading: true
 *     |
 *     v (check localStorage for session)
 * [AUTHENTICATED] <-- session exists (anonymous or phone-verified)
 *     |
 *     +--> isAnonymous: true (anonymous session)
 *     +--> isAnonymous: false (phone-verified session)
 *
 * On session change (applySession):
 *   1. Update React state (session, user)
 *   2. setRealtimeAuth(session.access_token) <-- ONLY place realtime auth is set
 *   3. Update invite status
 *
 * Returns:
 * - user: User | null
 * - session: Session | null
 * - loading: boolean
 * - isAuthenticated: boolean
 * - isAnonymous: boolean
 * - isFullySignedIn: boolean (authenticated + not anonymous + passed invite check)
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import {
  getSession,
  clearSession,
  getCachedUser,
  persistCachedUser,
  createAnonymousSession,
  isAnonymousUser,
  setRealtimeAuth,
} from '@/lib/supabase';
import { checkNeedsInviteCode } from '@/lib/api';

export function useAuth() {
  const [user, setUser] = useState<User | null>(() => getCachedUser());
  const [session, setSession] = useState<Session | null>(null);
  const [isFullySignedIn, setIsFullySignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [realtimeReady, setRealtimeReady] = useState(false);
  const initRef = useRef(false);

  const isAuthenticated = !!session;
  const isAnonymous = isAnonymousUser(user);

  const log = useCallback((message: string, payload?: Record<string, unknown>) => {
    console.log(`[Auth] ${message}`, payload ?? '');
  }, []);

  // Check invite code requirement
  const updateInviteStatus = useCallback(
    async (currentSession: Session | null, currentUser: User | null) => {
      if (!currentSession) {
        setIsFullySignedIn(false);
        return;
      }

      // Anonymous users are not "fully signed in"
      if (isAnonymousUser(currentUser)) {
        setIsFullySignedIn(false);
        return;
      }

      try {
        const needsInvite = await checkNeedsInviteCode();
        setIsFullySignedIn(!needsInvite);
        log('Invite check result', { needsInvite, isFullySignedIn: !needsInvite });
      } catch (error) {
        console.error('[Auth] Failed to check invite requirement', error);
        setIsFullySignedIn(false);
      }
    },
    [log]
  );

  // Apply a session (from login or refresh)
  // This is the SINGLE place where realtime auth is set
  const applySession = useCallback(
    async (origin: string, nextSession: Session | null) => {
      log(`Applying session (${origin})`, {
        hasSession: !!nextSession,
        isAnonymous: nextSession?.user?.is_anonymous,
      });
      setSession(nextSession);

      if (nextSession?.user) {
        setUser(nextSession.user);
        persistCachedUser(nextSession.user);
      } else {
        setUser(null);
        persistCachedUser(null);
      }

      // Set realtime auth - this is the ONLY place setAuth is called
      await setRealtimeAuth(nextSession?.access_token ?? null);
      setRealtimeReady(!!nextSession?.access_token);

      await updateInviteStatus(nextSession, nextSession?.user ?? null);
    },
    [log, updateInviteStatus]
  );

  // Manual refresh - call this after login
  const refreshAuthState = useCallback(async (reason = 'manual-refresh') => {
    log(`refreshAuthState (${reason})`);
    const currentSession = getSession();
    await applySession(reason, currentSession);
  }, [applySession, log]);

  // Sign out
  const signOut = useCallback(async () => {
    log('Signing out');
    clearSession();
    setSession(null);
    setUser(null);
    persistCachedUser(null);
    setIsFullySignedIn(false);

    // Create a new anonymous session
    try {
      const { session: anonSession } = await createAnonymousSession();
      await applySession('post-signout-anonymous', anonSession);
    } catch (error) {
      console.error('[Auth] Failed to create anonymous session after signout:', error);
    }
  }, [log, applySession]);

  // Initialize on mount
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const init = async () => {
      log('Initializing auth state...');

      const existingSession = getSession();

      if (existingSession) {
        log('Found session', {
          userId: existingSession.user?.id,
          isAnonymous: existingSession.user?.is_anonymous,
        });
        await applySession('init', existingSession);
      } else {
        // No session - create anonymous session
        log('No session found, creating anonymous session...');
        try {
          const { session: anonSession } = await createAnonymousSession();
          await applySession('init-anonymous', anonSession);
        } catch (error) {
          console.error('[Auth] Failed to create anonymous session:', error);
        }
      }

      setLoading(false);
    };

    init();
  }, [applySession, log]);

  // Log state changes
  useEffect(() => {
    log('State changed', {
      userId: user?.id,
      hasSession: !!session,
      isAuthenticated,
      isAnonymous,
      isFullySignedIn,
      loading,
    });
  }, [log, user, session, isAuthenticated, isAnonymous, isFullySignedIn, loading]);

  return {
    user,
    session,
    isAuthenticated,
    isAnonymous,
    isFullySignedIn,
    loading,
    realtimeReady,
    refreshAuthState,
    signOut,
  };
}
