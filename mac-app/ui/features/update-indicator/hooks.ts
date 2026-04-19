import { useEffect, useMemo, useRef, useState } from 'react';
import {
  checkForUpdates,
  downloadUpdate,
  restartToUpdate,
  subscribeToUpdateProgress,
  subscribeToUpdateStatus,
} from './api';
import { NONE_DISMISS_DELAY_MS, PORTAL_ID } from './config';
import type { UpdateStatusPayload, UseUpdateIndicatorResult } from './types';

type TimerRef = { current: ReturnType<typeof setTimeout> | null };

/**
 * Creates (or reuses) the portal root div used by the indicator, and
 * removes it from `document.body` on unmount.
 */
const usePortalContainer = (): HTMLElement => {
  const container = useMemo(() => {
    const existing = document.getElementById(PORTAL_ID);
    if (existing !== null) return existing;
    const node = document.createElement('div');
    node.id = PORTAL_ID;
    document.body.appendChild(node);
    return node;
  }, []);

  useEffect(() => {
    return () => {
      const node = document.getElementById(PORTAL_ID);
      if (node !== null) node.remove();
    };
  }, []);

  return container;
};

// `building` is treated as up-to-date in the UI — normalize at the boundary.
const effectiveStatusPayload = (payload: UpdateStatusPayload): UpdateStatusPayload =>
  payload.state === 'building' ? { ...payload, state: 'none' } : payload;

/**
 * Subscribes to IPC update-status + update-progress streams exactly once.
 * The subscription is guarded by a ref so re-renders don't re-subscribe.
 */
const useUpdateStatusSubscription = (
  setStatus: (payload: UpdateStatusPayload) => void,
  setProgress: (percent: number) => void,
  setShowNoneChip: (visible: boolean) => void,
  noneTimerRef: TimerRef
): void => {
  const attachedRef = useRef(false);

  useEffect(() => {
    if (attachedRef.current) return;
    attachedRef.current = true;

    subscribeToUpdateStatus((payload) => {
      if (noneTimerRef.current !== null) {
        clearTimeout(noneTimerRef.current);
        noneTimerRef.current = null;
      }
      const effective = effectiveStatusPayload(payload);
      setStatus(effective);

      if (effective.state === 'none') {
        setShowNoneChip(true);
        noneTimerRef.current = setTimeout(() => {
          setShowNoneChip(false);
          noneTimerRef.current = null;
        }, NONE_DISMISS_DELAY_MS);
      } else {
        setShowNoneChip(false);
      }
    });

    subscribeToUpdateProgress((percent) => {
      setProgress(percent);
    });

    return () => {
      if (noneTimerRef.current !== null) {
        clearTimeout(noneTimerRef.current);
      }
    };
  }, [setStatus, setProgress, setShowNoneChip, noneTimerRef]);
};

/**
 * All UpdateIndicator state lives here. The component is a pure renderer
 * over this hook's result. Business rules encoded:
 *
 *   - Exactly one IPC subscription across the component's lifetime
 *     (guarded by `attachedRef` — defends against StrictMode double
 *     effects).
 *   - A `building` status payload is mapped to `none` (treated as up-to-date).
 *   - The `none` chip auto-dismisses after `NONE_DISMISS_DELAY_MS`; re-emits
 *     of `none` reset the timer.
 *   - The dismiss action for `available` / `downloaded` remembers the
 *     dismissed version so re-emits of the same version stay hidden.
 */
export const useUpdateIndicator = (): UseUpdateIndicatorResult => {
  const [status, setStatus] = useState<UpdateStatusPayload>({ state: 'idle' });
  const [progress, setProgress] = useState(0);
  const [showNoneChip, setShowNoneChip] = useState(false);
  const dismissedVersionRef = useRef<string | null>(null);
  const noneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const container = usePortalContainer();
  useUpdateStatusSubscription(setStatus, setProgress, setShowNoneChip, noneTimerRef);

  const dismiss = (): void => {
    if (
      (status.state === 'available' || status.state === 'downloaded') &&
      status.version !== undefined &&
      status.version !== ''
    ) {
      dismissedVersionRef.current = status.version;
    }
    setStatus({ state: 'idle' });
    setShowNoneChip(false);
    if (noneTimerRef.current !== null) {
      clearTimeout(noneTimerRef.current);
      noneTimerRef.current = null;
    }
  };

  const isDismissedVersion =
    (status.state === 'available' || status.state === 'downloaded') &&
    dismissedVersionRef.current === status.version;

  return {
    status,
    progress,
    showNoneChip,
    container,
    dismiss,
    isDismissedVersion,
    onInstallNow: () => void downloadUpdate(),
    onRestartNow: () => void restartToUpdate(),
    onRetry: () => void checkForUpdates(),
  };
};
