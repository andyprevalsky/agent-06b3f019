/**
 * Presentational controls for BrowserStatusBarFullscreen — desktop overlay
 * chips plus the mobile control footer. Pure/stateless; extracted to keep the
 * fullscreen container under its size budget.
 *
 * STATE MACHINE (this file renders the AGENT OVERLAY STATE owned by
 * BrowserStatusBarFullscreen; it holds no state of its own — props select which
 * chip renders):
 * [ACTIVE_DESKTOP]      -> TakeControlChip over the browser ("Agent in progress";
 *                          the Root browser passes idleLabel: no agent animation)
 * [USER_CONTROL_DESKTOP] -> Hand-back control chip over the interactive browser
 * [WAITING_DESKTOP]     -> WaitingForAssistanceChip over the browser
 * [DISCONNECTED_DESKTOP] -> DisconnectedOverlay over the browser
 * [*_MOBILE]            -> MobileBrowserControlFooter below the browser, with
 *                          DISCONNECTED > WAITING > ACTIVE priority shared by
 *                          its label, animation, and action
 */

import { cn } from '@/lib/utils';
import ThinkingAnimation from '@/components/ThinkingAnimation';
import type { BrowserControlState } from '../browserControlState';

export function TakeControlChip({
  onResume,
  isResuming,
  isUserControlling,
  idleLabel,
}: {
  onResume: () => void;
  isResuming: boolean;
  isUserControlling: boolean;
  /** Label while nobody but the viewer is driving (Root browser); omitted = an agent is working. */
  idleLabel?: string;
}) {
  const agentWorking = !isUserControlling && idleLabel === undefined;
  return (
    <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10 max-w-[calc(100vw-24px)]">
      <div className="flex items-center gap-3 pl-4 pr-2 py-2 rounded-full bg-navi-black shadow-2xl">
        <div className="flex items-center gap-2">
          {agentWorking && (
            <ThinkingAnimation
              dataUrl="/thinking_animations.txt"
              autoplay
              loop
              className="w-4 h-4 flex-shrink-0"
              style={{ width: '16px', height: '16px' }}
            />
          )}
          <span className="whitespace-nowrap text-sm font-medium text-navi-white">
            {isUserControlling ? 'You have control' : (idleLabel ?? 'Agent in progress')}
          </span>
        </div>
        <button
          onClick={onResume}
          disabled={isResuming}
          className={cn(
            'whitespace-nowrap rounded-full bg-blue-500 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-blue-400',
            isResuming && 'cursor-not-allowed opacity-50',
          )}
        >
          {isResuming ? 'Loading...' : isUserControlling ? 'Hand back control' : 'Take control'}
        </button>
      </div>
    </div>
  );
}

export function MobileBrowserControlFooter({
  onResume,
  isResuming,
  controlState,
  request,
  isUserControlling,
}: {
  onResume: () => void;
  isResuming: boolean;
  controlState: BrowserControlState;
  request?: string;
  isUserControlling: boolean;
}) {
  const label = isUserControlling
    ? 'You have control'
    : controlState === 'disconnected'
      ? 'Browser disconnected'
      : controlState === 'waiting'
        ? (request ?? 'Agent waiting for assistance')
        : 'Agent in progress';
  const action = isUserControlling
    ? 'Hand back control'
    : controlState === 'waiting'
      ? 'Start Agent'
      : 'Take control';

  return (
    <div
      data-testid="mobile-browser-control-footer"
      className="flex w-full flex-none items-center justify-between gap-3 bg-navi-black px-4 py-3"
    >
      <div className="flex min-w-0 items-center gap-2">
        {controlState === 'active' && !isUserControlling && (
          <ThinkingAnimation
            dataUrl="/thinking_animations.txt"
            autoplay
            loop
            className="h-4 w-4 flex-shrink-0"
            style={{ width: '16px', height: '16px' }}
          />
        )}
        <span className="truncate text-sm font-medium text-navi-white">{label}</span>
      </div>
      <button
        onClick={onResume}
        disabled={isResuming}
        className={cn(
          'flex-none whitespace-nowrap rounded-full bg-blue-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-400',
          isResuming && 'cursor-not-allowed opacity-50',
        )}
      >
        {isResuming ? 'Loading...' : action}
      </button>
    </div>
  );
}

export function WaitingForAssistanceChip({
  onResume,
  isResuming,
  request,
  isMobile,
}: {
  onResume: () => void;
  isResuming: boolean;
  request: string;
  isMobile: boolean;
}) {
  return (
    <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10">
      <div
        className={cn(
          'flex w-max flex-col items-stretch overflow-hidden rounded-[20px] border border-white/10 bg-navi-black/90 shadow-2xl backdrop-blur-md',
          isMobile ? 'max-w-[calc(100vw-32px)]' : 'max-w-[calc(100vw-352px)]',
        )}
      >
        <div className="px-4 py-2.5 text-center">
          <span className="whitespace-nowrap text-sm font-medium text-navi-white">{request}</span>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-white/10 py-2 pl-4 pr-2">
          <span className="text-sm font-medium text-navi-white">Agent waiting for assistance</span>
          <button
            onClick={onResume}
            disabled={isResuming}
            className={cn(
              'text-sm font-medium ml-2 px-3 py-1 rounded-full bg-blue-500 text-white hover:bg-blue-400 transition-colors',
              isResuming && 'opacity-50 cursor-not-allowed',
            )}
          >
            {isResuming ? 'Loading...' : 'Start Agent'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DisconnectedOverlay({
  onResume,
  isResuming,
}: {
  onResume: () => void;
  isResuming: boolean;
}) {
  return (
    <div className="absolute inset-0 backdrop-blur-md flex items-center justify-center">
      <button
        onClick={onResume}
        disabled={isResuming}
        className={cn(
          'px-4 py-2 rounded-lg border border-foreground/20 bg-foreground/10 text-foreground',
          isResuming ? 'opacity-50' : 'hover:bg-foreground/20',
        )}
      >
        {isResuming ? 'Loading...' : 'Take Control'}
      </button>
    </div>
  );
}
