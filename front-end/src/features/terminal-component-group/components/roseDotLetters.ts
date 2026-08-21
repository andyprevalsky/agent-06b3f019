/**
 * The ROSE dot-matrix letterforms and the shared clock that cycles them.
 *
 * The sidebar's "working" indicator spells R → O → S → E on a 5x5 dot grid,
 * one letter per phase, each wiping in diagonally from the top-left. It is the
 * wordmark's own gesture reused as a progress signal, so a running agent looks
 * like the product rather than like a generic spinner.
 *
 * WHY A SHARED MODULE-LEVEL TICKER, not a hook-local interval:
 * every active row shows this indicator. A per-row interval would mean one
 * timer per running agent — cost scaling with agent count rather than with what
 * is on screen. Instead one interval serves every mounted indicator, it starts
 * on the first subscriber and stops on the last, and because all indicators read
 * the same phase they stay in lockstep (which also reads as deliberate rather
 * than as noise).
 *
 * Re-render blast radius is the 16px indicator only: subscribing happens inside
 * AgentStatusIndicator via useSyncExternalStore, so a phase change never
 * re-renders the row, the list, or the sidebar.
 */

/** 5x5 bitmaps, row-major, '1' = lit. Five rows is the minimum that reads. */
const LETTERS: readonly (readonly string[])[] = [
  // R
  ['11110', '10010', '11110', '10100', '10010'],
  // O
  ['01110', '10001', '10001', '10001', '01110'],
  // S
  ['01111', '10000', '01110', '00001', '11110'],
  // E
  ['11111', '10000', '11110', '10000', '11111'],
];

export const GRID_SIZE = 5;
export const LETTER_COUNT = LETTERS.length;
export const LETTER_NAMES = ['R', 'O', 'S', 'E'] as const;

/**
 * Each letter is drawn on diagonals: a dot's diagonal index is (row + col), so a
 * 5x5 grid has 9 of them, 0 at the top-left corner through 8 at the bottom-right.
 */
export const DIAGONAL_COUNT = GRID_SIZE * 2 - 1;

/**
 * Opacity a diagonal steps through once it starts revealing, then holds at 1.
 * Quantized on purpose — the stepping IS the effect; a smooth fade reads as a
 * blur rather than as a letter being drawn.
 */
export const RAMP = [0.25, 0.5, 0.75, 1] as const;

/** The draw ramp played backwards, used by the erase. */
export const RAMP_OUT = [0.75, 0.5, 0.25, 0] as const;

/**
 * Number of frames a full build occupies, i.e. frames 0..BUILD_FRAMES-1. The
 * last diagonal starts at frame DIAGONAL_COUNT-1 and needs RAMP.length frames to
 * reach full, so the letter is complete on frame BUILD_FRAMES-1.
 */
export const BUILD_FRAMES = DIAGONAL_COUNT - 1 + RAMP.length;

/** Frame index at which the letter is fully drawn. */
export const COMPLETE_FRAME = BUILD_FRAMES - 1;

/** Frames the finished letter holds at full opacity before it erases. */
export const HOLD_FRAMES = 8;

/**
 * The erase is the build played backwards, so it takes the same number of frames
 * and retreats bottom-right -> top-left. Cutting straight from a full letter to
 * an empty grid read as a flicker; mirroring makes the letter leave the way it
 * arrived.
 */
export const ERASE_FRAMES = BUILD_FRAMES;

export const FRAMES_PER_LETTER = BUILD_FRAMES + HOLD_FRAMES + ERASE_FRAMES;

/** Wall-clock per frame. 70ms x 20 frames ≈ 1.4s per letter. */
export const FRAME_MS = 70;

/** Flat 25-length lit/unlit mask for a letter, row-major from the top-left. */
export function letterMask(letterIndex: number): boolean[] {
  const rows = LETTERS[((letterIndex % LETTER_COUNT) + LETTER_COUNT) % LETTER_COUNT];
  return rows.flatMap((row) => Array.from(row, (cell) => cell === '1'));
}

/** Diagonal index of the i-th cell in row-major order. */
export function diagonalOf(cellIndex: number): number {
  return Math.floor(cellIndex / GRID_SIZE) + (cellIndex % GRID_SIZE);
}

/**
 * Opacity for one cell at one frame of a letter's full cycle.
 *
 * The cycle is draw -> hold -> erase, and the erase mirrors the draw in time:
 * the diagonal that appeared LAST is the first to leave, so the letter retreats
 * bottom-right -> top-left. Every letter therefore starts and ends on an empty
 * grid, and no two letters are ever on screen together.
 *
 * Unlit cells stay fully transparent throughout — the grid should read as a
 * letter, not as a letter floating on a field of ghost dots.
 */
export function cellOpacity(lit: boolean, diagonal: number, frame: number): number {
  if (!lit) return 0;

  // Draw: diagonal d starts at frame d, then steps up the ramp.
  if (frame < BUILD_FRAMES) {
    const step = frame - diagonal;
    return step < 0 ? 0 : RAMP[Math.min(step, RAMP.length - 1)];
  }

  // Hold: fully drawn.
  if (frame < BUILD_FRAMES + HOLD_FRAMES) return 1;

  // Erase: mirror the draw, so the last diagonal in is the first out.
  const eraseFrame = frame - BUILD_FRAMES - HOLD_FRAMES;
  const mirrored = DIAGONAL_COUNT - 1 - diagonal;
  const step = eraseFrame - mirrored;
  return step < 0 ? 1 : RAMP_OUT[Math.min(step, RAMP_OUT.length - 1)];
}

/** Total frames in a full R-O-S-E cycle. */
export const CYCLE_FRAMES = FRAMES_PER_LETTER * LETTER_COUNT;

/**
 * Per-agent offset into the cycle, so rows do not animate in lockstep.
 *
 * A sidebar where every indicator draws the same letter on the same frame reads
 * as one blinking widget rather than as N independent runs. Offsetting desyncs
 * them WITHOUT adding timers: there is still exactly one clock, and each row
 * just reads a different point on it.
 *
 * Derived from the agent id rather than randomised so a row keeps its phase
 * across re-renders, refetches and remounts — a row whose animation jumped on
 * every poll would be worse than perfect sync.
 */
export function phaseOffsetFor(seed: string): number {
  // FNV-1a: tiny, dependency-free, and well spread for short ASCII ids.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % CYCLE_FRAMES;
}

/** Which letter a global frame counter is currently drawing. */
export function letterIndexForFrame(frame: number): number {
  return Math.floor(frame / FRAMES_PER_LETTER) % LETTER_COUNT;
}

/** Frame offset within the current letter's build+hold cycle. */
export function frameWithinLetter(frame: number): number {
  return frame % FRAMES_PER_LETTER;
}

// ---------------------------------------------------------------------------
// Shared frame ticker
// ---------------------------------------------------------------------------

let frame = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

/**
 * Users who asked for reduced motion get a completed, static 'R' — both the
 * build and the letter cycle are motion, so honouring the preference means not
 * starting the timer at all rather than merely slowing it.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function subscribeToLetterPhase(onChange: () => void): () => void {
  listeners.add(onChange);

  if (timer === null && !prefersReducedMotion()) {
    timer = setInterval(() => {
      frame = (frame + 1) % (FRAMES_PER_LETTER * LETTER_COUNT);
      for (const listener of listeners) listener();
    }, FRAME_MS);
  }

  return () => {
    listeners.delete(onChange);
    // Last indicator unmounted — stop the clock rather than leaving it running
    // for a sidebar with nothing in it.
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export function getLetterPhase(): number {
  // Reduced motion never starts the timer, so reporting the raw counter would
  // pin the indicator to a permanently half-drawn letter. Report a finished one.
  return prefersReducedMotion() ? COMPLETE_FRAME : frame;
}

/** Server render wants a finished letter rather than a half-drawn one. */
export function getServerLetterPhase(): number {
  return COMPLETE_FRAME;
}

/** Test seam: reset module state between cases. */
export function resetLetterPhaseForTests(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
  frame = 0;
  listeners.clear();
}
