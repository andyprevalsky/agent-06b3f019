/**
 * STATE MACHINE: PopularGoalsCarousel
 * STATIC: Renders a horizontally scrolling ticker of popular goal buttons.
 *
 * FLAG (lib/roseDesktop.ts):
 *   stock         → POPULAR_GOALS; row spans the input column (unchanged).
 *   Rose Desktop  → ROSE_DESKTOP_POPULAR_GOALS first ("Import Code Repo" is a
 *                   plain pill, first in the rotation, never pinned — UI
 *                   ledger #15, #24), then POPULAR_GOALS. The row is exactly as
 *                   wide as the query box (same max-w-4xl + mx-auto as
 *                   QueryInput, ledger #55), so its left edge and the pills'
 *                   right-hand cutoff line up with the box's edges; 30px gap
 *                   down to the query box's nub (ledger #31).
 *
 * LAYOUT: [label (md+)] [ticker viewport (overflow hidden) > track (translated)]
 */

import type { RefObject } from 'react';

import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { cn } from '@/lib/utils';

import { POPULAR_GOALS, ROSE_DESKTOP_POPULAR_GOALS } from '../config';
import type { DripStyles } from '../types';

interface PopularGoalsCarouselProps {
  tickerOffset: number;
  tickerRef: RefObject<HTMLDivElement>;
  onGoalClick: (goal: string) => void;
  dripStyles: DripStyles;
  borderColor: number;
}

export function PopularGoalsCarousel({
  tickerOffset,
  tickerRef,
  onGoalClick,
  dripStyles,
  borderColor,
}: PopularGoalsCarouselProps) {
  const roseDesktop = useRoseDesktop();
  const goals = roseDesktop ? [...ROSE_DESKTOP_POPULAR_GOALS, ...POPULAR_GOALS] : POPULAR_GOALS;
  return (
    <div
      data-testid="popular-goals-row"
      className={cn(
        'relative z-10',
        roseDesktop ? 'mx-auto mb-[30px] w-full max-w-4xl' : 'mb-4',
      )}
    >
      <div className="flex items-center gap-3">
        <span className="hidden md:block text-sm text-muted-foreground whitespace-nowrap flex-shrink-0">
          Popular Goals
        </span>
        <div
          data-testid="popular-goals-viewport"
          className={cn('relative flex-1 overflow-hidden', roseDesktop && 'min-w-0')}
        >
          <div
            ref={tickerRef}
            data-testid="popular-goals-track"
            className="flex gap-2"
            style={{ transform: `translateX(-${tickerOffset}px)` }}
          >
            {[...goals, ...goals, ...goals].map((goal, i) => (
              <button
                key={i}
                onClick={() => onGoalClick(goal)}
                className="px-3 py-1 text-xs bg-secondary hover:bg-secondary/80 rounded-full whitespace-nowrap flex-shrink-0 border"
                style={{ borderColor: borderColor > 0 ? dripStyles.borderRgb : undefined }}
              >
                {goal}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
