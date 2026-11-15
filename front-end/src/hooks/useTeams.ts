/** Teams cache is keyed by session user; mutations refetch authoritative grants. */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AUTH_SESSION_CHANGED_EVENT,
  IMPERSONATION_CHANGED_EVENT,
  getSession,
} from '@/lib/supabase';
import {
  fetchShareableIntegrations,
  fetchTeams,
  type ShareableIntegration,
  type Team,
} from '@/lib/api/teams';

function currentTeamUserId(): string | null {
  const user = getSession()?.user;
  return user && !user.is_anonymous ? user.id : null;
}
export function useTeamSession() {
  const [userId, setUserId] = useState(currentTeamUserId);
  useEffect(() => {
    const refresh = () => setUserId(currentTeamUserId);
    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
    window.addEventListener(IMPERSONATION_CHANGED_EVENT, refresh);
    // Same-tab changes dispatch the events above; sign-out in another tab only fires `storage`.
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
      window.removeEventListener(IMPERSONATION_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return userId;
}
export function useTeams() {
  const userId = useTeamSession();
  const query = useQuery({
    queryKey: ['teams', userId],
    queryFn: ({ signal }) => fetchTeams(signal),
    enabled: userId !== null,
    retry: false,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
  return { ...query, userId };
}
export function useShareableIntegrations() {
  const userId = useTeamSession();
  return useQuery({
    queryKey: ['team-integrations', userId],
    queryFn: ({ signal }) => fetchShareableIntegrations(signal),
    enabled: userId !== null,
    retry: false,
    staleTime: 0,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}
export function useTeamMutation<T>(mutationFn: (input: T) => Promise<unknown>) {
  const client = useQueryClient();
  const userId = useTeamSession();
  return useMutation({
    mutationFn,
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['teams', userId] }),
        client.invalidateQueries({ queryKey: ['team-integrations', userId] }),
      ]),
  });
}

/** One shareable account plus the caller's accepted teams: what a sharing caption needs. */
export interface AccountShareTarget {
  account: ShareableIntegration;
  teams: Team[];
}
export type AccountShareLookup = (
  provider: 'gmail' | 'imessage',
  email?: string,
) => AccountShareTarget | undefined;

/**
 * Per-account sharing lookup for Integrations rows (both queries share one cache).
 * No target while loading, signed out, with no accepted team, or for an account the
 * backend does not list as shareable.
 */
export function useAccountShares(): { shareTarget: AccountShareLookup; error: string | null } {
  const teams = useTeams();
  const accounts = useShareableIntegrations();
  const joined = teams.data?.teams ?? [];
  const shareTarget: AccountShareLookup = (provider, email) => {
    if (joined.length === 0) return undefined;
    const key = email?.trim().toLowerCase();
    const account = accounts.data?.integrations.find(
      (item) => item.provider === provider && (key === undefined || item.accountEmail === key),
    );
    return account === undefined ? undefined : { account, teams: joined };
  };
  const failure = teams.error ?? accounts.error;
  return {
    shareTarget,
    error: teams.userId === null || failure === null ? null : failure.message,
  };
}
