/**
 * Per-page character budget for grep results.
 *
 * `MAX_RESULT_CHARS` existed in config but was never applied: broad patterns
 * over a 10k-message history returned 240-323 KB pages, which overflowed
 * explore-agent contexts and Temporal payloads (agent 599d97e6, 2026-09-08).
 */
import type { GrepMatch } from './types';

/** Paging metadata that tells the caller how the character budget applied. */
export interface GrepPageCharBounds {
  /** Per-page cap on summed match content chars (MAX_RESULT_CHARS). */
  applied_char_limit: number;
  /** True when trailing matches were dropped (or the first cut) to fit the cap. */
  char_truncated?: boolean;
}

/**
 * Keep whole matches in order while their content fits `maxChars`; a first
 * match that alone exceeds the budget is cut (never return an empty page for a
 * non-empty result). The caller rewrites paging metadata so the model can
 * continue with `offset` instead of silently losing the tail.
 */
export function boundMatchesByChars(
  matches: GrepMatch[],
  maxChars: number
): { matches: GrepMatch[]; charTruncated: boolean } {
  const kept: GrepMatch[] = [];
  let used = 0;
  for (const match of matches) {
    const length = match.content.length;
    if (used + length <= maxChars) {
      kept.push(match);
      used += length;
      continue;
    }
    if (kept.length === 0) {
      const budget = Math.max(0, maxChars - used);
      kept.push({
        ...match,
        content: `${match.content.slice(0, budget)}\n…[match content truncated to ${budget} chars]`,
      });
    }
    return { matches: kept, charTruncated: true };
  }
  return { matches: kept, charTruncated: false };
}
