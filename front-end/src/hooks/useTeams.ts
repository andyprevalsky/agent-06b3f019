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
  type ShareableProvider,
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
/**
 * `account` names the row's own account exactly: its accountId (Gmail address, PlaidItem.id,
 * `gh:owner/repo`, compute account id), its account email (Granola / Fireflies) or its
 * integration id (a CLI connection). Omit it only for a row that has one account
 * (iMessage, WhatsApp, LinkedIn).
 */
export type AccountShareLookup = (
  provider: ShareableProvider,
  account?: string | null,
) => AccountShareTarget | undefined;

function matches(item: ShareableIntegration, provider: string, account: string | null | undefined) {
  if (item.provider !== provider) return false;
  if (account === undefined || account === null) return true;
  const key = account.trim();
  return (
    item.accountId === key ||
    item.integrationId === key ||
    (item.accountEmail !== null && item.accountEmail === key.toLowerCase())
  );
}

/**
 * Per-account sharing lookup for Integrations rows (both queries share one cache).
 * No target while loading, signed out, with no accepted team, or for an account the
 * backend does not list as shareable.
 */
export function useAccountShares(): { shareTarget: AccountShareLookup; error: string | null } {
  const teams = useTeams();
  const accounts = useShareableIntegrations();
  const joined = teams.data?.teams ?? [];
  const shareTarget: AccountShareLookup = (provider, account) => {
    if (joined.length === 0) return undefined;
    const found = accounts.data?.integrations.find((item) => matches(item, provider, account));
    return found === undefined ? undefined : { account: found, teams: joined };
  };
  const failure = teams.error ?? accounts.error;
  return {
    shareTarget,
    error: teams.userId === null || failure === null ? null : failure.message,
  };
}
