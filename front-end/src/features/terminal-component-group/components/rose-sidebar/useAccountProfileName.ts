/**
 * STATE MACHINE: useAccountProfileName (Rose left bar account row, ledger row 63)
 *
 *   [OFF]      no session user, or anonymous → no request; name null, loading false
 *   [LOADING]  signed in, GET /api/user-settings in flight → loading true
 *              (the row shows the member icon in the initial's 20px box)
 *   [READY]    the backend User row's name (trimmed), or null when it is empty
 *   [FAILED]   request error → name null, loading false (auth metadata → email
 *              local part → phone take over in accountDisplayName)
 *
 * Same endpoint and client as Settings → Personal Info (lib/api/userSettings);
 * one cached request per signed-in account, never per agent.
 */

import type { User } from '@supabase/supabase-js';
import { useQuery } from '@tanstack/react-query';

import { fetchUserSettings } from '@/lib/api/userSettings';

const ACCOUNT_PROFILE_QUERY_KEY = 'account-profile';

function profileName(settings: Record<string, unknown>): string | null {
  const name = settings.name;
  return typeof name === 'string' && name.trim() !== '' ? name.trim() : null;
}

export function useAccountProfileName(user: User | null): {
  name: string | null;
  loading: boolean;
} {
  const enabled = user !== null && user.is_anonymous !== true;
  const query = useQuery({
    queryKey: [ACCOUNT_PROFILE_QUERY_KEY, user?.id ?? null],
    queryFn: fetchUserSettings,
    select: profileName,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
  return { name: query.data ?? null, loading: enabled && query.isPending };
}
