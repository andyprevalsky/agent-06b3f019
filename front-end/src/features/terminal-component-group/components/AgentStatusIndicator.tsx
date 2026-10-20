/**
 * STATE MACHINE: AgentStatusIndicator
 *
 * Stateless. Renders one of three mutually exclusive glyphs in a fixed-width
 * leading slot, so titles stay column-aligned no matter which state a row is in.
 *
 *   [active]     grayscale 5x5 dot matrix spelling R -> O -> S -> E, each letter
 *                drawn in diagonal-by-diagonal from the top-left corner
 *                (the ONLY animated state)
 *   [needs-help] static amber alert glyph (no motion — a stuck row sits still)
 *   [done]       static muted check (green #22c55e in dark mode), or a muted x
 *                when the run failed (useRoseTheme dark: the check adds a
 *                dark: green variant; light renders the stock gray check
 *                byte-for-byte)
 *
 * The three differ by silhouette AND color, not just motion — a 3x3 grid, a
 * ringed "!", and a check/x read apart instantly at 14px, and only needs-help is
 * chromatic. An earlier pass had working and needs-help both as brand-orange
 * dots separated only by a ring and a pulse; in a still frame they were
 * indistinguishable, which defeats the whole point of the needs-help state and
 * fails anyone running with reduced motion.
 *
 * See agentRunState.ts for how the seven backend statuses collapse into these
 * three families and why NEEDS_HELP outranks the raw status.
 *
 * Motion budget: the pulse animates only `opacity` and `transform`, both
 * GPU-composited, so a list of active rows costs no layout or paint work. Under
 * `prefers-reduced-motion` the pulse is dropped and the dot renders solid — the
 * state stays legible by color and shape alone, never by motion alone.
 */

import { useSyncExternalStore } from 'react';
import { AlertCircle, Check, X } from 'lucide-react';

import { useRoseTheme } from '@/features/rose-theme';
import { cn } from '@/lib/utils';

import type { AgentRunStatus } from './agentRunState';
import {
  CYCLE_FRAMES,
  LETTER_NAMES,
  cellOpacity,
  diagonalOf,
  frameWithinLetter,
  getLetterPhase,
  getServerLetterPhase,
  letterIndexForFrame,
  letterMask,
  phaseOffsetFor,
  subscribeToLetterPhase,
} from './roseDotLetters';

/** Fixed slot so every row's title starts at the same x, whatever the state. */
const SLOT = 'flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center';

/**
 * Working: the ROSE wordmark drawn on a 5x5 dot matrix, one letter at a time.
 *
 * Each letter is DRAWN IN diagonal by diagonal, starting at the top-left corner
 * (row+col = 0) and sweeping to the bottom-right (row+col = 8). A diagonal fades
 * up through 0.25 → 0.5 → 0.75 → 1 on successive frames and then holds, so the
 * letter accumulates rather than shimmering; once every diagonal is at full
 * opacity the finished letter holds briefly, then the next one starts from
 * scratch. Dots outside the letterform stay fully transparent — the grid should
 * read as a letter, not as a letter on a field of ghost dots.
 *
 * Opacity is computed per frame rather than expressed as CSS keyframes because a
 * cell's timeline depends on which of R/O/S/E include it; keyframes would need a
 * rule per distinct (diagonal x membership) combination.
 *
 * The frame counter is a single module-level clock (see roseDotLetters) read via
 * useSyncExternalStore, so ticking re-renders these 25 spans and nothing else —
 * not the row, not the list, not the sidebar.
 */
function ActiveDots({ seed }: { seed?: string }) {
  const tick = useSyncExternalStore(subscribeToLetterPhase, getLetterPhase, getServerLetterPhase);
  // Same clock for every row, different point on it — see phaseOffsetFor.
  const frame = (tick + (seed === undefined ? 0 : phaseOffsetFor(seed))) % CYCLE_FRAMES;
  const letterIndex = letterIndexForFrame(frame);
  const localFrame = frameWithinLetter(frame);
  const mask = letterMask(letterIndex);

  return (
    <span
      className={cn(SLOT, 'grid grid-cols-5 place-content-center gap-[0.5px]')}
      data-letter={LETTER_NAMES[letterIndex]}
    >
      {mask.map((lit, i) => (
        <span
          key={i}
          className="h-[2px] w-[2px] rounded-full bg-gray-600"
          style={{ opacity: cellOpacity(lit, diagonalOf(i), localFrame) }}
        />
      ))}
    </span>
  );
}

/**
 * Blocked on the user: a static amber alert glyph. Deliberately not red — this
 * is "your turn", not "something broke" — and deliberately a different shape
 * from the working dot so the two are separable in a still frame.
 */
function NeedsHelpDot() {
  return (
    <span className={cn(SLOT)}>
      <AlertCircle className="h-3.5 w-3.5 text-amber-500" strokeWidth={2.5} />
    </span>
  );
}

const STOCK_CHECK_CLASSES = 'h-3 w-3 text-gray-400';

/**
 * Terminal: muted so finished rows recede behind whatever is still running.
 * Rose dark mode turns the check green (UI ledger row 71). The green variant is
 * added only while dark, so light markup stays exactly the stock gray check.
 */
function DoneGlyph({ failed }: { failed: boolean }) {
  const { isDark } = useRoseTheme();
  return (
    <span className={cn(SLOT)}>
      {failed ? (
        <X className="h-3 w-3 text-red-400/80" strokeWidth={2.5} />
      ) : (
        <Check
          className={isDark ? `${STOCK_CHECK_CLASSES} dark:text-[#22c55e]` : STOCK_CHECK_CLASSES}
          strokeWidth={2.5}
        />
      )}
    </span>
  );
}

export default function AgentStatusIndicator({
  status,
  seed,
}: {
  status: AgentRunStatus;
  /** Agent id — desyncs this row's animation from its neighbours'. */
  seed?: string;
}) {
  return (
    <span role="img" aria-label={status.label} title={status.label}>
      {status.state === 'active' && <ActiveDots seed={seed} />}
      {status.state === 'needs-help' && <NeedsHelpDot />}
      {status.state === 'done' && <DoneGlyph failed={status.failed === true} />}
    </span>
  );
}
