/**
 * Loads the session user's active published UI.
 *
 *   userId null            → no request, stock UI
 *   userId set             → GET /api/user-ui/active once
 *   window focus           → refetch (picks up a publish from another tab/agent)
 *   DEV + ?rose_ui_live=1  → also poll every 5s (live demo after a publish)
 *
 * Only a change of versionId replaces state, so refetches never re-render
 * mounted frames. A baseUrl on the app origin is refused (stock UI).
 */
import { useEffect, useState } from 'react';

import { getQueryParams } from '@/lib/url';

import { fetchActiveUserUi } from '../api';
import {
  isAllowedUserContentUrl,
  LIVE_RELOAD_POLL_MS,
  LIVE_RELOAD_QUERY_PARAM,
  USER_UI_IS_DEV,
} from '../config';
import type { ActiveUserUi, ActiveUserUiResponse } from '../types';

function toActiveUserUi(response: ActiveUserUiResponse): ActiveUserUi | null {
  if (!response || typeof response.versionId !== 'string') return null;
  if (!response.manifest || typeof response.baseUrl !== 'string') return null;
  if (!isAllowedUserContentUrl(response.baseUrl)) {
    console.warn('[UserUi] refusing baseUrl outside the usercontent origin', response.baseUrl);
    return null;
  }
  return { versionId: response.versionId, manifest: response.manifest, baseUrl: response.baseUrl };
}

function shouldLivePoll(): boolean {
  return USER_UI_IS_DEV && getQueryParams().get(LIVE_RELOAD_QUERY_PARAM) === '1';
}

export function useActiveUserUi(userId: string | null): ActiveUserUi | null {
  const [active, setActive] = useState<ActiveUserUi | null>(null);

  useEffect(() => {
    setActive(null);
    if (!userId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const next = toActiveUserUi(await fetchActiveUserUi());
        if (cancelled) return;
        setActive((previous) =>
          previous?.versionId === next?.versionId && previous?.baseUrl === next?.baseUrl
            ? previous
            : next,
        );
      } catch (error) {
        console.warn('[UserUi] active version load failed', error);
      }
    };
    const onFocus = () => {
      void load();
    };
    void load();
    window.addEventListener('focus', onFocus);
    const poll = shouldLivePoll() ? window.setInterval(onFocus, LIVE_RELOAD_POLL_MS) : null;
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      if (poll !== null) window.clearInterval(poll);
    };
  }, [userId]);

  return active;
}
