/**
 * Loads the left-bar Apps list (GET /api/user-ui/apps).
 *
 *   userId null (flag off, anonymous, archive) → no request, nothing listed
 *   userId set → one GET on mount
 *   USER_UI_ACTIVE_CHANGED {versionId} (open agent's channel, or this tab's
 *     History restore) → exactly one GET, skipped when that version is the
 *     one already listed
 *   403 ROSE_DEV_ONLY / any failure before the first success → not loaded
 *     (the section renders nothing); a later failure keeps the last list
 *
 * 10k agents: no polling and no per-row reads; the cost is one GET per active
 * version change, independent of how many agents or apps the user has.
 * Responses apply in request order, so a slow older response cannot win.
 */
import { useEffect, useRef, useState } from 'react';

import { fetchUserApps, type UserAppEntry } from '@/lib/api/userApps';
import { onOpenAgentActivity } from '@/lib/openAgentActivity';

export interface UserAppsList {
  loaded: boolean;
  apps: UserAppEntry[];
  activeVersionId: string | null;
}

const EMPTY: UserAppsList = { loaded: false, apps: [], activeVersionId: null };

export function useUserAppsList(userId: string | null): UserAppsList {
  const [list, setList] = useState<UserAppsList>(EMPTY);
  const activeRef = useRef<string | null>(null);

  useEffect(() => {
    setList(EMPTY);
    activeRef.current = null;
    if (!userId) return;
    let cancelled = false;
    let requested = 0;
    let applied = 0;
    const load = async () => {
      const sequence = ++requested;
      try {
        const next = await fetchUserApps();
        if (cancelled || sequence < applied) return;
        applied = sequence;
        activeRef.current = next.activeVersionId;
        setList({ loaded: true, apps: next.apps, activeVersionId: next.activeVersionId });
      } catch (error) {
        console.warn('[UserApps] apps load failed', error);
      }
    };
    void load();
    const unlisten = onOpenAgentActivity((activity) => {
      if (activity.kind !== 'user-ui-active-changed') return;
      if (activity.versionId !== undefined && activity.versionId === activeRef.current) return;
      void load();
    });
    return () => {
      cancelled = true;
      unlisten();
    };
  }, [userId]);

  return list;
}
