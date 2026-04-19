import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { UpdateStatusPayload } from '../shared/types/ipc';

const NONE_DISMISS_DELAY = 3000;
const portalId = 'rose-update-indicator';

// Rose gradient colors for progress bar
const ROSE_GRADIENT = 'linear-gradient(to right, #094EFF, #537FFF, #84E4FF, #65CBDF)';

// Gift icon SVG path
const GiftIcon = () => (
  <svg
    className="h-3.5 w-3.5 text-neutral-600"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 3.5c1.5-1.5 4-1.5 5 0s1 3.5-1 5h4v3H4v-3h4c-2-1.5-2-4-1-5s3.5-1.5 5 0zM5 11.5v9h14v-9M12 8.5v12"
    />
  </svg>
);

// Checkmark icon
const CheckIcon = () => (
  <svg
    className="h-3.5 w-3.5 text-neutral-600"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2.5}
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
  </svg>
);

// Warning icon
const WarningIcon = () => (
  <svg
    className="h-3.5 w-3.5 text-neutral-600"
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
    />
  </svg>
);

// Base chip styling
const chipBase =
  'flex items-center rounded-full bg-neutral-100 border border-neutral-200 px-3 py-1.5 shadow-sm';

export default function UpdateIndicator() {
  const [status, setStatus] = useState<UpdateStatusPayload>({ state: 'idle' });
  const [progress, setProgress] = useState(0);
  const [showNoneChip, setShowNoneChip] = useState(false);
  const dismissedVersionRef = useRef<string | null>(null);
  const noneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenerAttachedRef = useRef(false);

  const container = useMemo(() => {
    const existing = document.getElementById(portalId);
    if (existing) return existing;
    const node = document.createElement('div');
    node.id = portalId;
    document.body.appendChild(node);
    return node;
  }, []);

  useEffect(() => {
    return () => {
      const node = document.getElementById(portalId);
      if (node) node.remove();
    };
  }, []);

  useEffect(() => {
    if (listenerAttachedRef.current) return;
    listenerAttachedRef.current = true;

    window.api.onUpdateStatus((payload) => {
      if (noneTimerRef.current) {
        clearTimeout(noneTimerRef.current);
        noneTimerRef.current = null;
      }

      // Map "building" state to "none" (treat as up to date)
      const effectivePayload =
        payload.state === 'building' ? { ...payload, state: 'none' as const } : payload;

      setStatus(effectivePayload);

      // Handle "none" state - show chip then auto-dismiss
      if (effectivePayload.state === 'none') {
        setShowNoneChip(true);
        noneTimerRef.current = setTimeout(() => {
          setShowNoneChip(false);
          noneTimerRef.current = null;
        }, NONE_DISMISS_DELAY);
      } else {
        setShowNoneChip(false);
      }
    });

    window.api.onUpdateProgress((percent) => {
      setProgress(percent);
    });

    return () => {
      if (noneTimerRef.current) {
        clearTimeout(noneTimerRef.current);
      }
    };
  }, []);

  const dismiss = () => {
    if ((status.state === 'available' || status.state === 'downloaded') && status.version) {
      dismissedVersionRef.current = status.version;
    }
    setStatus({ state: 'idle' });
    setShowNoneChip(false);
    if (noneTimerRef.current) {
      clearTimeout(noneTimerRef.current);
      noneTimerRef.current = null;
    }
  };

  const isDismissedVersion =
    (status.state === 'available' || status.state === 'downloaded') &&
    dismissedVersionRef.current === status.version;

  // Don't show anything for idle or dismissed versions
  if (status.state === 'idle' || isDismissedVersion) {
    return null;
  }

  // CHECKING - Spinner only
  if (status.state === 'checking') {
    return createPortal(
      <div className="pointer-events-none fixed bottom-6 left-6 z-[9999]">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
      </div>,
      container
    );
  }

  // NONE (Up to date) - Auto-dismissing chip
  if (status.state === 'none') {
    if (!showNoneChip) return null;
    return createPortal(
      <div className="pointer-events-auto fixed bottom-6 left-6 z-[9999]">
        <div
          className={`${chipBase} gap-2 cursor-pointer hover:bg-neutral-200 transition-colors`}
          onClick={dismiss}
        >
          <CheckIcon />
          <span className="text-xs font-medium text-neutral-600">Up to date</span>
        </div>
      </div>,
      container
    );
  }

  // AVAILABLE - New update available with Install Now
  if (status.state === 'available') {
    return createPortal(
      <div className="pointer-events-auto fixed bottom-6 left-6 z-[9999]">
        <div className={`${chipBase} justify-between gap-4`}>
          <div className="flex items-center gap-2">
            <GiftIcon />
            <span className="text-xs font-medium text-neutral-600">New update available</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={dismiss}
              className="text-xs font-medium text-neutral-500 hover:text-neutral-700 transition-colors"
            >
              Later
            </button>
            <button
              onClick={() => window.api.downloadUpdate()}
              className="text-xs font-medium text-neutral-700 bg-neutral-200 hover:bg-neutral-300 px-2.5 py-1 rounded-full transition-colors"
            >
              Install Now
            </button>
          </div>
        </div>
      </div>,
      container
    );
  }

  // DOWNLOADING - Progress bar with rose gradient
  if (status.state === 'downloading') {
    const percent = Math.round(status.percent ?? progress ?? 0);
    return createPortal(
      <div className="pointer-events-auto fixed bottom-6 left-6 z-[9999]">
        <div className={`${chipBase} gap-3 min-w-[200px]`}>
          <span className="text-xs font-medium text-neutral-600">Downloading...</span>
          <div className="flex-1 h-1.5 rounded-full bg-neutral-200 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-200"
              style={{
                width: `${Math.min(percent, 100)}%`,
                background: ROSE_GRADIENT,
              }}
            />
          </div>
        </div>
      </div>,
      container
    );
  }

  // DOWNLOADED - Ready to restart
  if (status.state === 'downloaded') {
    return createPortal(
      <div className="pointer-events-auto fixed bottom-6 left-6 z-[9999]">
        <div className={`${chipBase} justify-between gap-4`}>
          <div className="flex items-center gap-2">
            <GiftIcon />
            <span className="text-xs font-medium text-neutral-600">New update available</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={dismiss}
              className="text-xs font-medium text-neutral-500 hover:text-neutral-700 transition-colors"
            >
              Later
            </button>
            <button
              onClick={() => window.api.restartToUpdate()}
              className="text-xs font-medium text-neutral-700 bg-neutral-200 hover:bg-neutral-300 px-2.5 py-1 rounded-full transition-colors"
            >
              Restart Now
            </button>
          </div>
        </div>
      </div>,
      container
    );
  }

  // ERROR - Chip with retry
  if (status.state === 'error') {
    return createPortal(
      <div className="pointer-events-auto fixed bottom-6 left-6 z-[9999]">
        <div className={`${chipBase} justify-between gap-4`}>
          <div className="flex items-center gap-2">
            <WarningIcon />
            <span className="text-xs font-medium text-neutral-600">Update failed</span>
          </div>
          <button
            onClick={() => window.api.checkForUpdates()}
            className="text-xs font-medium text-neutral-700 bg-neutral-200 hover:bg-neutral-300 px-2.5 py-1 rounded-full transition-colors"
          >
            Retry
          </button>
        </div>
      </div>,
      container
    );
  }

  return null;
}
