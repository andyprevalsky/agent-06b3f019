/**
 * STATE MACHINE: useAuth
 *
 * AUTH INITIALIZATION:
 * [LOADING] <-- loading: true
 *     |
 *     v (check existing session)
 * [ANONYMOUS] <-- user exists but isAnonymous: true
 *   or
 * [FULLY_SIGNED_IN] <-- isFullySignedIn: true (real user, not anonymous)
 *   or
 * [NO_SESSION] <-- user: null
 *
 * AUTH FLOW:
 * [NO_SESSION] or [ANONYMOUS]
 *     |
 *     | (user signs in)
 *     v
 * [SIGNED_IN] <-- session exists, user exists
 *     |
 *     | (check invite code requirement)
 *     v
 * [NEEDS_INVITE] <-- needsInviteCode: true (must enter code first)
 *   or
 * [FULLY_SIGNED_IN] <-- needsInviteCode: false
 *
 * Returns:
 * - user: User | null
 * - session: Session | null
 * - loading: boolean
 * - isAuthenticated: boolean
 * - isAnonymous: boolean
 * - isFullySignedIn: boolean
 * - needsInviteCode: boolean
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import {
  supabase,
  getStoredSession,
  getCachedUser,
  persistCachedUser,
  signInAnonymously,
  isAnonymousUser,
} from '@/lib/supabase';
import { checkNeedsInviteCode } from '@/lib/api';

export function useAuth() {
  const [user, setUser] = useState<User | null>(() => getCachedUser());
  const [session, setSession] = useState<Session | null>(() => getStoredSession());
  const [isFullySignedIn, setIsFullySignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const initRef = useRef(false);
  const inviteCheckRef = useRef(0);
  const anonInitRef = useRef(false);

  // Derived state - isAuthenticated means we have a valid Supabase session (anonymous or not)
  const isAuthenticated = !!session;
  const isAnonymous = isAnonymousUser(user);

  const log = useCallback((message: string, payload?: Record<string, unknown>) => {
    console.log(`[Auth] ${message}`, payload ?? '');
  }, []);

  const updateInviteStatus = useCallback(
    async (origin: string, currentSession: Session | null, currentUser: User | null) => {
      inviteCheckRef.current += 1;
      const checkId = inviteCheckRef.current;

      if (!currentSession) {
        log(`No session available for invite check (${origin})`);
        setIsFullySignedIn(false);
        return;
      }

      // Anonymous users are not "fully signed in" - they need to verify phone
      if (isAnonymousUser(currentUser)) {
        log(`Anonymous user - not fully signed in (${origin})`);
        setIsFullySignedIn(false);
        return;
      }

      try {
        log(`Checking invite requirement (${origin})`);
        const needsInvite = await checkNeedsInviteCode();
        if (inviteCheckRef.current !== checkId) {
          log('Invite check result discarded due to newer request');
          return;
        }
        setIsFullySignedIn(!needsInvite);
        log('Invite requirement result', { needsInvite, isFullySignedIn: !needsInvite });
      } catch (error) {
        console.error('[Auth] Failed to check invite requirement', error);
        if (inviteCheckRef.current === checkId) {
          setIsFullySignedIn(false);
        }
      }
    },
    [log]
  );

  const applySession = useCallback(
    async (origin: string, nextSession: Session | null) => {
      log(`Applying session (${origin})`, { hasSession: !!nextSession, isAnonymous: nextSession?.user?.is_anonymous });
      setSession(nextSession);

      if (nextSession?.user) {
        setUser(nextSession.user);
        persistCachedUser(nextSession.user);
      } else {
        setUser(null);
        persistCachedUser(null);
      }

      await updateInviteStatus(origin, nextSession, nextSession?.user ?? null);
    },
    [log, updateInviteStatus]
  );

  // Initialize anonymous user when no session exists
  const initializeAnon = useCallback(async () => {
    if (anonInitRef.current) return;
    anonInitRef.current = true;

    log('No session found, signing in anonymously...');

    try {
      const { session: anonSession } = await signInAnonymously();
      if (anonSession) {
        log('Anonymous session created', { userId: anonSession.user?.id });
        await applySession('anonymous-init', anonSession);
      }
    } catch (error) {
      console.error('[Auth] Failed to sign in anonymously:', error);
      anonInitRef.current = false; // Allow retry
    }
  }, [log, applySession]);

  // Manual refresh - call this after login or invite code submission
  const refreshAuthState = useCallback(async (reason = 'manual-refresh') => {
    const { data: { session: currentSession } } = await supabase.auth.getSession();
    await applySession(reason, currentSession);
  }, [applySession]);

  // Initialize once on mount
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const init = async () => {
      log('Initializing auth state...');

      // Check for existing session
      const { data: { session: existingSession } } = await supabase.auth.getSession();

      if (existingSession) {
        log('Found existing session', {
          userId: existingSession.user?.id,
          isAnonymous: existingSession.user?.is_anonymous
        });
        await applySession('init', existingSession);
      } else {
        // No session - create anonymous user
        await initializeAnon();
      }

      setLoading(false);
    };

    init();

    // Listen for auth state changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      log('Supabase auth event', { event, hasSession: !!session, isAnonymous: session?.user?.is_anonymous });

      // Handle the session change
      if (event === 'SIGNED_OUT') {
        // On sign out, create a new anonymous session
        anonInitRef.current = false;
        initializeAnon();
      } else {
        applySession(`supabase:${event}`, session ?? null);
      }
    });

    return () => subscription.unsubscribe();
  }, [applySession, log, initializeAnon]);

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
    refreshAuthState,
    signOut: () => supabase.auth.signOut(),
  };
}
