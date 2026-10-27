/**
 * Trajectory user view must not mention Fast Mode / DEMO cache.
 *
 * [RAW TOOL TEXT] -> strip Fast Mode / demo-cache / cached-trajectory sentences
 * [ONLY INTERNAL COPY] -> empty string (chip shows the state label only)
 * [MIXED USER COPY] -> keep the non-internal sentences
 * USER messages are never passed through this helper.
 */
const DEMO_CACHE_MENTION = /fast\s*mode|fast[\s_-]*cache|cached\s+trajectory|from_fast_cache/i;

const DEMO_CACHE_SENTENCE =
  /[^.!?\n]*?(?:fast\s*mode|fast[\s_-]*cache|cached\s+trajectory|from_fast_cache)[^.!?\n]*[.!?]?/gi;

const EXPLORE_PLACEHOLDER = /^(research started\.?)$/i;

export function isExplorePlumbingCopy(text: string | null | undefined): boolean {
  const visible = userFacingMessageText(text);
  if (!visible) return true;
  return EXPLORE_PLACEHOLDER.test(visible);
}

export function userFacingMessageText(text: string | null | undefined): string {
  if (!text) return '';
  if (EXPLORE_PLACEHOLDER.test(text.trim())) return '';
  if (!DEMO_CACHE_MENTION.test(text)) return text;
  return text.replace(DEMO_CACHE_SENTENCE, ' ').replace(/\s+/g, ' ').trim();
}
