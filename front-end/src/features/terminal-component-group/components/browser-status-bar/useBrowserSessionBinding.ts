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
 */

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { readBrowserLiveView } from '@/lib/api';
import {
  getBrowserSessionBinding,
  publishBrowserSessionBinding,
  subscribeBrowserSessionBinding,
} from '@/lib/browserSessionBindings';

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
  return {
    browserUrl: boundUrl ?? transcriptUrl,
    isBound: boundUrl !== null,
    isLive: binding?.live !== false,
    refresh,
  };
}
