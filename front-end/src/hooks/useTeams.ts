/** Teams cache is keyed by session user; mutations refetch authoritative grants. */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AUTH_SESSION_CHANGED_EVENT,
  IMPERSONATION_CHANGED_EVENT,
  getSession,
} from '@/lib/supabase';
import { fetchShareableIntegrations, fetchTeams } from '@/lib/api/teams';

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
    return () => {
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
      window.removeEventListener(IMPERSONATION_CHANGED_EVENT, refresh);
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
