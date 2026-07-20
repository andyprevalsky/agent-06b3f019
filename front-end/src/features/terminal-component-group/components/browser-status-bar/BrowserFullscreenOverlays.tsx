/**
 * Presentational overlay chips for BrowserStatusBarFullscreen — the
 * take-control affordance, the auth-assistance handoff, and the disconnected
 * resume overlay. Pure/stateless; extracted to keep the fullscreen container
 * under its size budget.
 */

import { cn } from '@/lib/utils';
import ThinkingAnimation from '@/components/ThinkingAnimation';

export function TakeControlChip({
  onResume,
  isResuming,
}: {
  onResume: () => void;
  isResuming: boolean;
}) {
  return (
    <div className="absolute bottom-10 left-1/2 -translate-x-1/2 z-10">
      <div className="flex items-center gap-3 pl-4 pr-2 py-2 rounded-full bg-navi-black shadow-2xl">
        <div className="flex items-center gap-2">
          <ThinkingAnimation
            dataUrl="/thinking_animations.txt"
            autoplay
            loop
            className="w-4 h-4 flex-shrink-0"
            style={{ width: '16px', height: '16px' }}
          />
          <span className="text-sm font-medium text-navi-white">Agent in progress</span>
        </div>
        <button
          onClick={onResume}
          disabled={isResuming}
          className={cn(
            'text-sm font-medium ml-6 px-3 py-1 rounded-full bg-blue-500 text-white hover:bg-blue-400 transition-colors',
            isResuming && 'opacity-50 cursor-not-allowed',
          )}
        >
          {isResuming ? 'Loading...' : 'Take control'}
        </button>
      </div>
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
