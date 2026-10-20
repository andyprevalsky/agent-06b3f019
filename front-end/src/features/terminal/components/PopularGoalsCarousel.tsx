/**
 * STATE MACHINE: PopularGoalsCarousel
 * STATIC: Renders a horizontally scrolling ticker of popular goal buttons.
 *
 * FLAG (lib/roseDesktop.ts):
 *   stock         → POPULAR_GOALS; row spans the input column (unchanged).
 *   Rose Desktop  → ROSE_DESKTOP_POPULAR_GOALS first ("Import Code Repo" is a
 *                   plain pill, first in the rotation, never pinned — UI
 *                   ledger #15, #24), then POPULAR_GOALS minus
 *                   ROSE_DESKTOP_HIDDEN_POPULAR_GOALS. The row is exactly as
 *                   wide as the query box (same max-w-4xl + mx-auto as
 *                   QueryInput, ledger #55), so its left edge and the pills'
 *                   right-hand cutoff line up with the box's edges; 30px gap
 *                   down to the query box's nub (ledger #31).
 *
 * THEME (useRoseTheme, Rose Desktop dark mode only): the pills are the mock's
 *   dark controls (panels/dark.js button[class*="border"]): #2f2f2c fill,
 *   rgba(255,255,255,.12) border (replaces the inline drip border), #e4e4df
 *   text, same shape; the label reads #a3a39d. Light renders the stock markup.
 *
 * LAYOUT: [label (md+)] [ticker viewport (overflow hidden) > track (translated)]
 */

import type { RefObject } from 'react';

import { useRoseTheme } from '@/features/rose-theme';
import { useRoseDesktop } from '@/hooks/roseDesktopContext';
import { cn } from '@/lib/utils';

import {
  POPULAR_GOALS,
  ROSE_DESKTOP_HIDDEN_POPULAR_GOALS,
  ROSE_DESKTOP_POPULAR_GOALS,
} from '../config';
import type { DripStyles } from '../types';

const ROSE_DESKTOP_GOALS = [
  ...ROSE_DESKTOP_POPULAR_GOALS,
  ...POPULAR_GOALS.filter((goal) => !ROSE_DESKTOP_HIDDEN_POPULAR_GOALS.includes(goal)),
];

const GOAL_PILL_CLASS =
  'px-3 py-1 text-xs bg-secondary hover:bg-secondary/80 rounded-full whitespace-nowrap flex-shrink-0 border';
/** Rose dark pill colors (mock); same shape as the stock pill. */
const ROSE_DARK_GOAL_PILL_CLASS = 'dark:bg-[#2f2f2c] dark:hover:bg-[#383835] dark:text-[#e4e4df]';
const ROSE_DARK_GOAL_PILL_BORDER = 'rgba(255, 255, 255, 0.12)';
const LABEL_CLASS = 'hidden md:block text-sm text-muted-foreground whitespace-nowrap flex-shrink-0';

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
  const roseDark = useRoseTheme().isDark;
  const goals = roseDesktop ? ROSE_DESKTOP_GOALS : POPULAR_GOALS;
  const stockBorder = borderColor > 0 ? dripStyles.borderRgb : undefined;
  return (
    <div
      data-testid="popular-goals-row"
      className={cn('relative z-10', roseDesktop ? 'mx-auto mb-[30px] w-full max-w-4xl' : 'mb-4')}
    >
      <div className="flex items-center gap-3">
        <span className={roseDark ? `${LABEL_CLASS} dark:text-[#a3a39d]` : LABEL_CLASS}>
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
                className={
                  roseDark ? `${GOAL_PILL_CLASS} ${ROSE_DARK_GOAL_PILL_CLASS}` : GOAL_PILL_CLASS
                }
                style={{ borderColor: roseDark ? ROSE_DARK_GOAL_PILL_BORDER : stockBorder }}
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
