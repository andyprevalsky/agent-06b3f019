/**
 * Terminal feature — auth/amplitude/logout glue hook.
 *
 * Owns:
 *   - Syncing the authenticated user into Amplitude.
 *   - Exposing a `handleLogout` callback that tears down local terminal state,
 *     signs out of Supabase, and routes back to the agents list view.
 */

import { useCallback, useEffect } from 'react';

import type { useAuth } from '@/features/auth';
import * as analytics from '@/lib/analytics';
import { signOut, clearStoredSession } from '@/lib/supabase';
import { useToast } from '@/hooks/use-toast';

import type { Agent, TerminalView } from '../types';

type Auth = ReturnType<typeof useAuth>;

export interface UseTerminalAuthArgs {
  auth: Auth;
  setAgents: (a: Agent[]) => void;
  setSelectedAgentId: (id: string | null) => void;
  setMessageInput: (v: string) => void;
  setCurrentView: (v: TerminalView) => void;
}

export function useTerminalAuth({
  auth,
  setAgents,
  setSelectedAgentId,
  setMessageInput,
  setCurrentView,
}: UseTerminalAuthArgs) {
  const { toast } = useToast();

  useEffect(() => {
    if (!auth.isAuthenticated || !auth.user) return;
    analytics.setUserId(auth.user.phone || auth.user.id);
  }, [auth.isAuthenticated, auth.user]);

  const handleLogout = useCallback(async () => {
    try {
      await signOut();
      clearStoredSession();
      await auth.refreshAuthState('logout');
      setAgents([]);
      setSelectedAgentId(null);
      setMessageInput('');
      setCurrentView('agents');
      analytics.reset();
    } catch (err: unknown) {
      console.error('[Auth] Logout failed', err);
      toast({ title: 'Error', description: 'Failed to log out', variant: 'destructive' });
    }
  }, [auth, setAgents, setSelectedAgentId, setMessageInput, setCurrentView, toast]);

  return { handleLogout };
}
