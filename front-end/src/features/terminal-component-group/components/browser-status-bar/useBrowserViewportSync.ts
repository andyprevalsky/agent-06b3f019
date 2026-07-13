/**
 * REMOTE VIEWPORT SYNC STATE:
 * [OBSERVING_PANE] -- dimensions change --> [DEBOUNCING]
 * [DEBOUNCING] -- 150ms stable --> [SYNCING_REMOTE_VIEWPORT]
 * [SYNCING_REMOTE_VIEWPORT] -- complete/fail --> [OBSERVING_PANE]
 */

import { useEffect, type RefObject } from 'react';
import { resizeBrowserSessionViewport } from '@/lib/api/browser-session';

const RESIZE_DEBOUNCE_MS = 150;

export function useBrowserViewportSync(taskId: string, paneRef: RefObject<HTMLElement>) {
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;

    let timeoutId: number | undefined;
    let lastQueued = '';
    let disposed = false;
    let resizeQueue = Promise.resolve();
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width <= 0 || height <= 0) return;

      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        const dimensions = `${width}x${height}`;
        if (dimensions === lastQueued) return;
        lastQueued = dimensions;
        resizeQueue = resizeQueue
          .then(() =>
            disposed ? undefined : resizeBrowserSessionViewport(taskId, { width, height }),
          )
          .catch(() => undefined);
      }, RESIZE_DEBOUNCE_MS);
    });

    observer.observe(pane);
    return () => {
      disposed = true;
      window.clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, [paneRef, taskId]);
}
