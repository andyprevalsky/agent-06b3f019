/**
 * STATE MACHINE: PopularGoalsCarousel
 * STATIC: Renders a horizontally scrolling ticker of popular goal buttons.
 * Rose Desktop accounts see ROSE_DESKTOP_POPULAR_GOALS first.
 */

import type { RefObject } from 'react';

import { useRoseDesktop } from '@/hooks/roseDesktopContext';

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
  const goals = useRoseDesktop()
    ? [...ROSE_DESKTOP_POPULAR_GOALS, ...POPULAR_GOALS]
    : POPULAR_GOALS;
  return (
    <div className="mb-4 relative z-10">
      <div className="flex items-center gap-3">
        <span className="hidden md:block text-sm text-muted-foreground whitespace-nowrap flex-shrink-0">
          Popular Goals
        </span>
        <div className="relative flex-1 overflow-hidden">
          <div
            ref={tickerRef}
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
