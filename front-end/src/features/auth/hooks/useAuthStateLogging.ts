import { useEffect } from 'react';
import type { User, Session } from '@supabase/supabase-js';

import { logAuth } from './initAuthSession';

interface AuthStateSnapshot {
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  isAnonymous: boolean;
  isFullySignedIn: boolean;
  loading: boolean;
}

/** Debug-only: logs auth state transitions. No behavioral side effects. */
export function useAuthStateLogging(state: AuthStateSnapshot): void {
  const { user, session, isAuthenticated, isAnonymous, isFullySignedIn, loading } = state;
  useEffect(() => {
    logAuth('State changed', {
      userId: user?.id,
      hasSession: !!session,
      isAuthenticated,
      isAnonymous,
      isFullySignedIn,
      loading,
    });
  }, [user, session, isAuthenticated, isAnonymous, isFullySignedIn, loading]);
}
