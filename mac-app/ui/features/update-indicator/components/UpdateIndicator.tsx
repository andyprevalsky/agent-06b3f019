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
 *
 * Look: every chip sits inside the Quick-Query launcher's liquid-metal ring
 * (ui/shared/liquid-metal) and follows the main window's html.dark via
 * Tailwind dark: variants (theme only; no state change).
 */

import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { LiquidMetalRing, LIQUID_METAL_RING_PX } from '../../../shared/liquid-metal';
import { CHIP_BASE, CHIP_LABEL, ROSE_GRADIENT } from '../config';
import { useUpdateIndicator } from '../hooks';
import type { UpdateStatusPayload } from '../types';
import { CheckIcon, GiftIcon, WarningIcon } from './Icons';

const BTN_SECONDARY =
  'text-xs font-medium text-neutral-500 hover:text-neutral-700 transition-colors dark:text-[#a3a39d] dark:hover:text-[#f2f2ef]';
const BTN_PRIMARY =
  'text-xs font-medium text-neutral-700 bg-neutral-200 hover:bg-neutral-300 px-2.5 py-1 rounded-full transition-colors dark:text-[#f2f2ef] dark:bg-white/10 dark:hover:bg-white/[0.16]';
const METAL_CHIP_SHADOW =
  'relative rounded-full shadow-[0_4px_12px_rgba(0,0,0,0.15),0_2px_4px_rgba(0,0,0,0.1)] dark:shadow-[0_6px_18px_rgba(0,0,0,0.45),0_2px_4px_rgba(0,0,0,0.3)]';

/** Chip fill inside the launcher's liquid-metal ring. */
const MetalChip = ({
  className,
  onClick,
  children,
}: {
  className: string;
  onClick?: () => void;
  children: ReactNode;
}): React.ReactElement => (
  <div
    className={METAL_CHIP_SHADOW}
    style={{ padding: LIQUID_METAL_RING_PX }}
    data-testid="update-chip"
  >
    <LiquidMetalRing radius={9999} />
    <div className={`${CHIP_BASE} ${className}`} onClick={onClick}>
      {children}
    </div>
  </div>
);

const renderInPortal = (
  container: HTMLElement,
  interactive: boolean,
  children: React.ReactNode
): React.ReactElement =>
  createPortal(
    <div className={interactive ? 'pointer-events-auto' : 'pointer-events-none'}>{children}</div>,
    container
  );

const CheckingChip = ({ container }: { container: HTMLElement }): React.ReactElement =>
  renderInPortal(
    container,
    false,
    <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent dark:border-[#8c8c86] dark:border-t-transparent" />
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
    <MetalChip
      className="gap-2 cursor-pointer hover:bg-neutral-200 transition-colors dark:hover:bg-[#2f2f2c]"
      onClick={onDismiss}
    >
      <CheckIcon />
      <span className={CHIP_LABEL}>Up to date</span>
    </MetalChip>
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
    <MetalChip className="justify-between gap-4">
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
    </MetalChip>
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
    <MetalChip className="gap-3 min-w-[200px]">
      <span className={CHIP_LABEL}>Downloading...</span>
      <div className="flex-1 h-1.5 rounded-full bg-neutral-200 overflow-hidden dark:bg-white/10">
        <div
          className="h-full rounded-full transition-all duration-200"
          style={{
            width: `${Math.min(percent, 100)}%`,
            background: ROSE_GRADIENT,
          }}
        />
      </div>
    </MetalChip>
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
    <MetalChip className="justify-between gap-4">
      <div className="flex items-center gap-2">
        <WarningIcon />
        <span className={CHIP_LABEL}>Update failed</span>
      </div>
      <button onClick={onRetry} className={BTN_PRIMARY}>
        Retry
      </button>
    </MetalChip>
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
