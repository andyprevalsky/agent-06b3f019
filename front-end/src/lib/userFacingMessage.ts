/**
 * Trajectory user view must not mention Fast Mode / fast cache.
 *
 * [RAW TOOL TEXT] -> strip Fast Mode / fast-cache / cached-trajectory sentences
 * [ONLY INTERNAL COPY] -> empty string (chip shows the state label only)
 * [MIXED USER COPY] -> keep the non-internal sentences
 * USER messages are never passed through this helper.
 */
const FAST_CACHE_MENTION = /fast\s*mode|fast[\s_-]*cache|cached\s+trajectory|from_fast_cache/i;

const FAST_CACHE_SENTENCE =
  /[^.!?\n]*?(?:fast\s*mode|fast[\s_-]*cache|cached\s+trajectory|from_fast_cache)[^.!?\n]*[.!?]?/gi;

export function userFacingMessageText(text: string | null | undefined): string {
  if (!text) return '';
  if (!FAST_CACHE_MENTION.test(text)) return text;
  return text.replace(FAST_CACHE_SENTENCE, ' ').replace(/\s+/g, ' ').trim();
}
