/**
 * Loads the session user's active published UI.
 *
 *   userId null            → no request, stock UI
 *   userId set             → GET /api/user-ui/active once
 *   window focus           → refetch (picks up a publish from another tab/agent)
 *   DEV + ?rose_ui_live=1  → also poll every 5s (live demo after a publish)
 *   liveRefresh (Rose Desktop only):
 *     open agent message/status, sub-agent tree change (existing channels),
 *     refreshActiveUserUi(), `user_ui.published` → coalesced refetch: at most
 *     one GET per 750ms window, never two in flight, cancelled on unmount
 *     USER_UI_ACTIVE_CHANGED {versionId} on the open agent's channel → same
 *     coalesced refetch, skipped when that versionId is already applied
 *
 * Only a change of versionId replaces state, so refetches never re-render
 * mounted frames. A baseUrl on the app origin is refused (stock UI). Responses
 * are applied in request order, so a slow older response cannot win.
 */
import { useEffect, useRef, useState } from 'react';

import { getQueryParams } from '@/lib/url';
import { onOpenAgentActivity } from '@/lib/openAgentActivity';

import { fetchActiveUserUi } from '../api';
import {
  isAllowedUserContentUrl,
  LIVE_RELOAD_POLL_MS,
  LIVE_RELOAD_QUERY_PARAM,
  USER_UI_IS_DEV,
} from '../config';
import type { ActiveUserUi, ActiveUserUiResponse } from '../types';
import { createRefreshCoalescer, registerUserUiRefresher } from './liveRefresh';

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

export interface UseActiveUserUiOptions {
  /** Refetch on open-agent activity and the live-refresh hook point (Rose Desktop). */
  liveRefresh?: boolean;
}

/** Live-refresh wiring: coalesced refetch on agent activity + the global hook point. */
function startLiveRefresh(
  load: () => Promise<void>,
  currentVersionId: () => string | null,
): () => void {
  const coalescer = createRefreshCoalescer(load);
  const unregister = registerUserUiRefresher({ request: coalescer.request, currentVersionId });
  const unlisten = onOpenAgentActivity((activity) => {
    // USER_UI_ACTIVE_CHANGED names the new version: skip it when already applied.
    if (activity.kind === 'user-ui-active-changed' && activity.versionId === currentVersionId()) {
      return;
    }
    coalescer.request();
  });
  return () => {
    unlisten();
    unregister();
    coalescer.dispose();
  };
}

export function useActiveUserUi(
  userId: string | null,
  { liveRefresh = false }: UseActiveUserUiOptions = {},
): ActiveUserUi | null {
  const [active, setActive] = useState<ActiveUserUi | null>(null);
  // Written only from effects/async callbacks: the session's loader and the
  // versionId it last applied (for `user_ui.published` dedupe).
  const loadRef = useRef<(() => Promise<void>) | null>(null);
  const appliedVersionRef = useRef<string | null>(null);

  useEffect(() => {
    setActive(null);
    appliedVersionRef.current = null;
    if (!userId) return;
    let cancelled = false;
    let requested = 0;
    let applied = 0;
    const load = async () => {
      const sequence = ++requested;
      try {
        const next = toActiveUserUi(await fetchActiveUserUi());
        if (cancelled || sequence < applied) return;
        applied = sequence;
        appliedVersionRef.current = next?.versionId ?? null;
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
    loadRef.current = load;
    void load();
    window.addEventListener('focus', onFocus);
    const poll = shouldLivePoll() ? window.setInterval(onFocus, LIVE_RELOAD_POLL_MS) : null;
    return () => {
      cancelled = true;
      loadRef.current = null;
      window.removeEventListener('focus', onFocus);
      if (poll !== null) window.clearInterval(poll);
    };
  }, [userId]);

  // Separate effect: toggling the flag never resets the applied UI.
  useEffect(() => {
    if (!userId || !liveRefresh) return;
    return startLiveRefresh(
      () => loadRef.current?.() ?? Promise.resolve(),
      () => appliedVersionRef.current,
    );
  }, [userId, liveRefresh]);

  return active;
}
