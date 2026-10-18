/**
 * [BROWSER_ACTIVE|WAITING|DISCONNECTED|USER] -> existing browser status.
 * [PHONE_WAITING] -> yellow Waiting for phone; [PHONE_AGENT] -> Phone active;
 * [PHONE_USER] -> You have phone control; release restores browser status.
 * Desktop/mobile share this status authority and accessible close control.
 */
import type { MouseEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BrowserControlState } from '../browserControlState';
import { BrowserProxyLocationChip } from './BrowserProxyLocationChip';
import type { BrowserSessionMetadata } from './types';
export interface PhoneHeaderStatus {
  label: string;
  active: boolean;
}

function ActiveIndicator({
  controlState,
  isUserControlling,
  phoneStatus,
}: {
  controlState: BrowserControlState;
  isUserControlling: boolean;
  phoneStatus?: PhoneHeaderStatus;
}) {
  const label =
    phoneStatus?.label ??
    (isUserControlling
      ? 'You have control'
      : controlState === 'disconnected'
        ? 'Disconnected'
        : controlState === 'waiting'
          ? 'Waiting for assistance'
          : 'Active');
  return (
    <div data-testid="fullscreen-activity-status" className="flex min-w-0 items-center gap-2">
      <div
        className={cn(
          'h-2 w-2 flex-shrink-0 rounded-full',
          (phoneStatus?.active ?? controlState === 'active')
            ? 'bg-green-500 animate-pulse'
            : 'bg-yellow-500',
        )}
      />
      <span className="truncate text-sm font-medium">{label}</span>
    </div>
  );
}

/** Desktop frame header: Active state + proxy chip + close. */
export function DesktopFrameHeader({
  controlState,
  browserSessionMetadata,
  onClose,
  isUserControlling,
  phoneStatus,
}: {
  controlState: BrowserControlState;
  browserSessionMetadata: BrowserSessionMetadata | null;
  onClose: (e: MouseEvent) => void;
  isUserControlling: boolean;
  phoneStatus?: PhoneHeaderStatus;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border p-4">
      <ActiveIndicator
        controlState={controlState}
        isUserControlling={isUserControlling}
        phoneStatus={phoneStatus}
      />
      <div className="flex items-center gap-2">
        <BrowserProxyLocationChip metadata={browserSessionMetadata} tooltipPosition="bottom" />
        <button
          aria-label="Close browser view"
          onClick={onClose}
          className="rounded p-2 transition-colors hover:bg-muted"
        >
          <X className="h-5 w-5 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}

/** Fixed mobile header: Active state + close. */
export function MobileFrameHeader({
  controlState,
  onClose,
  isUserControlling,
  phoneStatus,
}: {
  controlState: BrowserControlState;
  onClose: (e: MouseEvent) => void;
  isUserControlling: boolean;
  phoneStatus?: PhoneHeaderStatus;
}) {
  return (
    <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <ActiveIndicator
        controlState={controlState}
        isUserControlling={isUserControlling}
        phoneStatus={phoneStatus}
      />
      <button
        aria-label="Close browser view"
        onClick={onClose}
        className="rounded p-1.5 transition-colors hover:bg-muted"
      >
        <X className="h-5 w-5 text-muted-foreground" />
      </button>
    </div>
  );
}
