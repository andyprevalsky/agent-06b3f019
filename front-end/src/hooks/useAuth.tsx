import { useEffect, useState, useCallback, useRef } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import { supabase, getStoredSession, getCachedUser, persistCachedUser } from '@/lib/supabase';
import { checkNeedsInviteCode } from '@/lib/api';

export function useAuth() {
  const [user, setUser] = useState<User | null>(() => getCachedUser());
  const [session, setSession] = useState<Session | null>(() => getStoredSession());
  const [isFullySignedIn, setIsFullySignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const initRef = useRef(false);
  const inviteCheckRef = useRef(0);

  const log = useCallback((message: string, payload?: Record<string, unknown>) => {
    console.log(`[Auth] ${message}`, payload ?? '');
  }, []);

  const updateInviteStatus = useCallback(
    async (origin: string, currentSession: Session | null) => {
      inviteCheckRef.current += 1;
      const checkId = inviteCheckRef.current;

      if (!currentSession) {
        log(`No session available for invite check (${origin})`);
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
      log(`Applying session (${origin})`, { hasSession: !!nextSession });
      setSession(nextSession);

      if (nextSession?.user) {
        setUser(nextSession.user);
        persistCachedUser(nextSession.user);
      } else {
        setUser(null);
        persistCachedUser(null);
      }

      await updateInviteStatus(origin, nextSession);
    },
    [log, updateInviteStatus]
  );

  // Manual refresh - call this after login or invite code submission
  const refreshAuthState = useCallback(async (reason = 'manual-refresh') => {
    const stored = getStoredSession();
    await applySession(reason, stored);
  }, [applySession]);

  // Initialize once on mount
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    
    const init = async () => {
      log('Initializing auth state...');
      await refreshAuthState('init');
      setLoading(false);
    };
    
    init();
    
    // Listen for sign out only
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      log('Supabase auth event', { event, hasSession: !!session });
      applySession(`supabase:${event}`, session ?? null);
    });
    
    return () => subscription.unsubscribe();
  }, [applySession, log, refreshAuthState]);

  useEffect(() => {
    log('State changed', {
      userId: user?.id,
      hasSession: !!session,
      isFullySignedIn,
      loading,
    });
  }, [log, user, session, isFullySignedIn, loading]);

  return {
    user,
    session,
    isFullySignedIn,
    loading,
    refreshAuthState,
    signOut: () => supabase.auth.signOut(),
  };
}
