/**
 * Authoritative live-view URL and liveness for one browser task.
 *
 * BINDING STATE:
 * [TRANSCRIPT_URL] latest metadata.browser_url (no binding known yet)
 *   |  GET /browser-session/task/:taskId/live-view on mount, on every
 *   |  transcript URL change, and when the tab regains focus/visibility
 *   |  BROWSER_SESSION broadcasts on agent:<id> (rebind / pause / close)
 *   v
 * [BOUND] BrowserSession.debugUrl + live
 *   live=false (closed, or the provider ended it) -> LiveViewLoading, no iframe
 *   live=true|null                                -> iframe on the bound URL
 *
 * The backend rebinds the task's row and broadcasts before releasing the old
 * provider session, so the bound URL never names a session the backend has
 * already released. The transcript URL lags until the worker posts again.
 * There is no interval poll: broadcasts carry changes, and the GET only
 * recovers state after mount, a missed broadcast, or a hidden tab.
 *
 * TILION TOKEN STATE (bound URL is a Tilion viewer page; token lasts 1800 s):
 * [HELD] adopted URL for session S at t0
 *   |  a read returns S with a re-minted token  -> stay HELD (no iframe reload)
 *   |  a read/broadcast names another session   -> HELD on the new URL at now
 *   |  t0 + 25 min                              -> fresh GET (retried every
 *   v                                              minute until one lands)
 * [DUE] next URL for S is adopted -> HELD at now (iframe remounts once)
 * Expired or closed sessions arrive as live=false and show LiveViewLoading.
 * The URL carries a view token: never log it.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { readBrowserLiveView } from '@/lib/api';
import {
  getBrowserSessionBinding,
  publishBrowserSessionBinding,
  subscribeBrowserSessionBinding,
} from '@/lib/browserSessionBindings';
import {
  TILION_LIVE_VIEW_REFRESH_MS,
  nextHeldTilionLiveView,
  presentHeldLiveViewUrl,
  type HeldTilionLiveView,
} from './liveViewDisplay';

export interface BrowserSessionBindingView {
  browserUrl: string;
  /** True when a binding is known (its URL wins over a pending handoff URL). */
  isBound: boolean;
  /** False only when the backend reports the bound session closed or ended. */
  isLive: boolean;
  /** Start a fresh binding read (e.g. right after a resume rebinds the task). */
  refresh: () => Promise<void>;
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Passive reads (mount, focus, transcript change) share one in-flight request.
 * `fresh` starts a new one: after a resume, a read issued before the rebind
 * committed cannot stand in for the post-resume binding.
 */
function readBinding(taskId: string, fresh: boolean): Promise<void> {
  const pending = inFlight.get(taskId);
  if (pending !== undefined && !fresh) return pending;
  const request: Promise<void> = readBrowserLiveView(taskId)
    .then(publishBrowserSessionBinding)
    .finally(() => {
      if (inFlight.get(taskId) === request) inFlight.delete(taskId);
    });
  inFlight.set(taskId, request);
  return request;
}

export function useBrowserSessionBinding(
  taskId: string,
  transcriptUrl: string,
): BrowserSessionBindingView {
  const subscribe = useCallback(
    (listener: () => void) => subscribeBrowserSessionBinding(taskId, listener),
    [taskId],
  );
  const binding = useSyncExternalStore(subscribe, () => getBrowserSessionBinding(taskId));
  const reportedFailure = useRef(false);
  const read = useCallback(
    (fresh: boolean) =>
      readBinding(taskId, fresh).then(
        () => {
          reportedFailure.current = false;
        },
        (error: unknown) => {
          if (reportedFailure.current) return;
          reportedFailure.current = true;
          console.error('Failed to read the browser session binding:', error);
        },
      ),
    [taskId],
  );
  const refresh = useCallback(() => read(true), [read]);

  useEffect(() => {
    void read(false);
  }, [read, transcriptUrl]);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void read(false);
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
    };
  }, [read]);

  const boundUrl = binding?.debugUrl ?? null;
  const heldTilion = useHeldTilionLiveView(boundUrl, refresh);
  const presentedUrl = presentHeldLiveViewUrl(heldTilion, boundUrl);
  return {
    browserUrl: presentedUrl ?? transcriptUrl,
    isBound: boundUrl !== null,
    isLive: binding?.live !== false,
    refresh,
  };
}

/** Retry cadence once a Tilion token is due and the refresh read has not landed. */
const TILION_REFRESH_RETRY_MS = 60_000;

/** Hold one Tilion viewer URL per session and re-mint it before the token expires. */
function useHeldTilionLiveView(
  boundUrl: string | null,
  refresh: () => Promise<void>,
): HeldTilionLiveView | null {
  const [held, setHeld] = useState<HeldTilionLiveView | null>(null);
  useEffect(() => {
    setHeld((previous) => nextHeldTilionLiveView(previous, boundUrl, Date.now()));
  }, [boundUrl]);
  useEffect(() => {
    if (held === null) return undefined;
    let timer: number | undefined;
    const schedule = (delayMs: number) => {
      timer = window.setTimeout(() => {
        void refresh();
        schedule(TILION_REFRESH_RETRY_MS);
      }, delayMs);
    };
    schedule(Math.max(0, held.adoptedAtMs + TILION_LIVE_VIEW_REFRESH_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [held, refresh]);
  return held;
}
