/**
 * StepProgressBar — thin gradient progress bar showing "Steps Taken N/M" for
 * the currently active browser task. Used by the expanded and fullscreen
 * BrowserStatusBar views.
 */

import type { StepProgress } from './types';

const GRADIENT = 'linear-gradient(to right, #094EFF, #537FFF, #84E4FF, #65CBDF)';

export function StepProgressBar({ progress }: { progress: StepProgress }) {
  const { stepsTaken, totalSteps } = progress;
  const pct = (stepsTaken / totalSteps) * 100;
  const bgSize = (totalSteps / stepsTaken) * 100;
  return (
    <div className="space-y-1">
      <div className="text-[10px] text-muted-foreground">
        <span>
          Steps Taken {stepsTaken}/{totalSteps}
        </span>
      </div>
      <div className="h-1 bg-gray-200 dark:bg-[#383835] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${pct}%`,
            background: GRADIENT,
            backgroundSize: `${bgSize}% 100%`,
            backgroundPosition: 'left',
          }}
        />
      </div>
    </div>
  );
}
