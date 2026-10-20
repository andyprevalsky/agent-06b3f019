/**
 * Data hooks for the Browser drawer's world state (plan row A6).
 *
 * FETCH POLICY (10k-agent rule): every read is enabled only while the Browser
 * drawer is open on a Rose Desktop account. There is no interval poll and no
 * window-focus refetch; reads happen on open, on a shown-agent / shown-task
 * change, and after the user's own open / close / forget actions.
 *
 *   useRootBrowserState  GET /browser-world/root            (drawer open on Root)
 *   useRootSites         GET /browser-world/sites           (Sites list shown)
 *   useAgentBrowserWorld GET /browser-world/agents/:agentId (shown agent only)
 *   useRootBrowserActions
 *     open  --POST /root/open-->  cache {root}
 *     close --POST /root/close--> cache {root: null}; receipt text for 6 s;
 *            Root and sites re-read (the close merged sites into Root)
 *   useForgetRootSite  DELETE /sites/:site --> the site leaves both caches
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  closeRootBrowser,
  forgetRootSite,
  listRootSites,
  openRootBrowser,
  readAgentBrowserWorld,
  readRootBrowser,
  type RootBrowserState,
  type RootSiteView,
} from '@/lib/api/browser-world';
import { receiptText } from './browserWorldView';

const WORLD_KEY = 'browser-world';
export const ROOT_BROWSER_KEY = [WORLD_KEY, 'root'] as const;
export const ROOT_SITES_KEY = [WORLD_KEY, 'sites'] as const;
export const RECEIPT_VISIBLE_MS = 6_000;

const READ_OPTIONS = { refetchOnWindowFocus: false, retry: false } as const;

export function useRootBrowserState(enabled: boolean) {
  return useQuery({
    queryKey: ROOT_BROWSER_KEY,
    queryFn: readRootBrowser,
    enabled,
    ...READ_OPTIONS,
  });
}

export function useRootSites(enabled: boolean) {
  return useQuery({ queryKey: ROOT_SITES_KEY, queryFn: listRootSites, enabled, ...READ_OPTIONS });
}

/** `shownTask` re-reads when the shown task or its liveness changes (a close merges). */
export function useAgentBrowserWorld(agentId: string | null, shownTask: string, enabled: boolean) {
  return useQuery({
    queryKey: [WORLD_KEY, 'agent', agentId, shownTask],
    queryFn: () => readAgentBrowserWorld(agentId ?? ''),
    enabled: enabled && agentId !== null,
    ...READ_OPTIONS,
  });
}

function useTransientText(): [string | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (text === null) return undefined;
    const timer = window.setTimeout(() => setText(null), RECEIPT_VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  return [text, setText];
}

export function useRootBrowserActions() {
  const queryClient = useQueryClient();
  const [receipt, showReceipt] = useTransientText();
  const setRoot = (root: RootBrowserState['root']) =>
    queryClient.setQueryData<RootBrowserState>(ROOT_BROWSER_KEY, (prev) => ({
      root,
      sites: prev?.sites ?? [],
    }));
  const refreshWorld = () => queryClient.invalidateQueries({ queryKey: [WORLD_KEY] });

  const open = useMutation({
    mutationFn: () => openRootBrowser(),
    onSuccess: (root) => setRoot(root),
  });
  const close = useMutation({
    mutationFn: closeRootBrowser,
    onSuccess: (worldState) => {
      setRoot(null);
      showReceipt(receiptText(worldState));
      void refreshWorld();
    },
    // Already closed elsewhere (404) or failed: re-read what Root really is.
    onError: () => void refreshWorld(),
  });
  return { open, close, receipt };
}

export function useForgetRootSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: forgetRootSite,
    onSuccess: (_forgotten, site) => {
      const without = (sites: RootSiteView[]) => sites.filter((s) => s.site !== site);
      queryClient.setQueryData<RootSiteView[]>(ROOT_SITES_KEY, (prev) =>
        prev === undefined ? prev : without(prev),
      );
      queryClient.setQueryData<RootBrowserState>(ROOT_BROWSER_KEY, (prev) =>
        prev === undefined ? prev : { ...prev, sites: without(prev.sites) },
      );
    },
  });
}
