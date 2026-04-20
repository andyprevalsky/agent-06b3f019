/**
 * UpdateIndicator — renders the auto-updater chip in the renderer's bottom-
 * left corner via a React portal.
 *
 * State machine (see hooks.ts for the orchestrator):
 *   idle ──onUpdateStatus──▶ checking ─▶ available ─▶ downloading ─▶ downloaded
 *     ▲                                         │
 *     └────────── dismiss / Later ──────────────┘
 *   building ──(mapped)──▶ none (auto-dismiss 3s) ─▶ hidden
 *   any ──onUpdateStatus(error)──▶ error ──Retry──▶ checkForUpdates()
 *
 * This component is a thin renderer over `useUpdateIndicator`; no IPC or
 * business logic lives here.
 */

import { createPortal } from 'react-dom';
import { CHIP_BASE, ROSE_GRADIENT } from '../config';
import { useUpdateIndicator } from '../hooks';
import type { UpdateStatusPayload } from '../types';
import { CheckIcon, GiftIcon, WarningIcon } from './Icons';

const CHIP_SLOT = 'fixed bottom-6 left-6 z-[9999]';
const CHIP_LABEL = 'text-xs font-medium text-neutral-600';
const BTN_SECONDARY =
  'text-xs font-medium text-neutral-500 hover:text-neutral-700 transition-colors';
const BTN_PRIMARY =
  'text-xs font-medium text-neutral-700 bg-neutral-200 hover:bg-neutral-300 px-2.5 py-1 rounded-full transition-colors';

const renderInPortal = (
  container: HTMLElement,
  interactive: boolean,
  children: React.ReactNode
): React.ReactElement =>
  createPortal(
    <div className={`${interactive ? 'pointer-events-auto' : 'pointer-events-none'} ${CHIP_SLOT}`}>
      {children}
    </div>,
    container
  );

const CheckingChip = ({ container }: { container: HTMLElement }): React.ReactElement =>
  renderInPortal(
    container,
    false,
    <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
  );

const UpToDateChip = ({
  container,
  onDismiss,
}: {
  container: HTMLElement;
  onDismiss: () => void;
}): React.ReactElement =>
  renderInPortal(
    container,
    true,
    <div
      className={`${CHIP_BASE} gap-2 cursor-pointer hover:bg-neutral-200 transition-colors`}
      onClick={onDismiss}
    >
      <CheckIcon />
      <span className={CHIP_LABEL}>Up to date</span>
    </div>
  );

const ActionableChip = ({
  container,
  onLater,
  onAction,
  actionLabel,
}: {
  container: HTMLElement;
  onLater: () => void;
  onAction: () => void;
  actionLabel: string;
}): React.ReactElement =>
  renderInPortal(
    container,
    true,
    <div className={`${CHIP_BASE} justify-between gap-4`}>
      <div className="flex items-center gap-2">
        <GiftIcon />
        <span className={CHIP_LABEL}>New update available</span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onLater} className={BTN_SECONDARY}>
          Later
        </button>
        <button onClick={onAction} className={BTN_PRIMARY}>
          {actionLabel}
        </button>
      </div>
    </div>
  );

const DownloadingChip = ({
  container,
  percent,
}: {
  container: HTMLElement;
  percent: number;
}): React.ReactElement =>
  renderInPortal(
    container,
    true,
    <div className={`${CHIP_BASE} gap-3 min-w-[200px]`}>
      <span className={CHIP_LABEL}>Downloading...</span>
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
  );

const ErrorChip = ({
  container,
  onRetry,
}: {
  container: HTMLElement;
  onRetry: () => void;
}): React.ReactElement =>
  renderInPortal(
    container,
    true,
    <div className={`${CHIP_BASE} justify-between gap-4`}>
      <div className="flex items-center gap-2">
        <WarningIcon />
        <span className={CHIP_LABEL}>Update failed</span>
      </div>
      <button onClick={onRetry} className={BTN_PRIMARY}>
        Retry
      </button>
    </div>
  );

const getDownloadingPercent = (status: UpdateStatusPayload, progress: number): number => {
  if (status.state !== 'downloading') return 0;
  const raw = status.percent !== undefined ? status.percent : progress;
  return Math.round(raw);
};

export default function UpdateIndicator(): React.ReactElement | null {
  const {
    status,
    progress,
    showNoneChip,
    container,
    dismiss,
    isDismissedVersion,
    onInstallNow,
    onRestartNow,
    onRetry,
  } = useUpdateIndicator();

  if (status.state === 'idle' || isDismissedVersion) return null;

  if (status.state === 'checking') return <CheckingChip container={container} />;

  if (status.state === 'none') {
    if (!showNoneChip) return null;
    return <UpToDateChip container={container} onDismiss={dismiss} />;
  }

  if (status.state === 'available') {
    return (
      <ActionableChip
        container={container}
        onLater={dismiss}
        onAction={onInstallNow}
        actionLabel="Install Now"
      />
    );
  }

  if (status.state === 'downloading') {
    return (
      <DownloadingChip container={container} percent={getDownloadingPercent(status, progress)} />
    );
  }

  if (status.state === 'downloaded') {
    return (
      <ActionableChip
        container={container}
        onLater={dismiss}
        onAction={onRestartNow}
        actionLabel="Restart Now"
      />
    );
  }

  if (status.state === 'error') {
    return <ErrorChip container={container} onRetry={onRetry} />;
  }

  return null;
}
