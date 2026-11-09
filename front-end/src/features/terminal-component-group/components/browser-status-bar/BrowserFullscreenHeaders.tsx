/**
 * [BROWSER_ACTIVE|WAITING|DISCONNECTED|USER] -> existing browser status.
 * [PHONE_WAITING] -> yellow Waiting for phone; [PHONE_AGENT] -> Phone active;
 * [PHONE_USER] -> You have phone control; release restores browser status.
 * [GLOBAL CONTROLS] -> reserved row only while phone is visible; ordinary browser stays body-fixed.
 * Desktop/mobile share this status authority and accessible close control.
 */
import type { MouseEvent } from 'react';
import { GlobalControlsSlot } from '@/components/GlobalControlsLayout';
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
    <div className="flex shrink-0 flex-col border-b border-border px-4 py-2">
      <div className="flex items-center justify-between">
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
      {phoneStatus && <GlobalControlsSlot />}
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
    <div className="flex flex-shrink-0 flex-col border-b border-border px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
      <div className="flex items-center justify-between gap-2">
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
      {phoneStatus && <GlobalControlsSlot />}
    </div>
  );
}
