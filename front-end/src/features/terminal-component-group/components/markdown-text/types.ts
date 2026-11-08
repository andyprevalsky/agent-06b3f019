/**
 * Animation constants for FadeInMarkdown's word-by-word fade.
 */

/** Total animation budget (seconds) from first word to last. */
export const MAX_ANIMATION_SECONDS = 3.0;
/** Initial delay before first word fades in. */
export const BASE_DELAY_SECONDS = 0.05;
/** Fade-in duration per word. */
export const FADE_DURATION_SECONDS = 0.35;
/** Upper bound on per-word delay regardless of word count. */
export const MAX_PER_WORD_DELAY_SECONDS = 0.04;

/** Compute per-word delay so total animation stays under MAX_ANIMATION_SECONDS. */
export function computePerWordDelay(wordCount: number): number {
  const available = MAX_ANIMATION_SECONDS - BASE_DELAY_SECONDS - FADE_DURATION_SECONDS;
  return Math.min(MAX_PER_WORD_DELAY_SECONDS, available / Math.max(wordCount, 1));
}
