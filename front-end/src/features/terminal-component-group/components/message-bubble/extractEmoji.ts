/**
 * Extract leading emoji from a text string.
 *
 * Used by ToolMessage to separate tool-card icons from the title text.
 *
 * The pattern is split across two subpatterns joined with alternation so we
 * do not put ZWJ / variation selectors / keycap combining marks inside a
 * character class (which triggers `no-misleading-character-class`).
 */

// Base emoji codepoints (ranges).
const EMOJI_CP =
  '[\\u{1F300}-\\u{1F9FF}\\u{2600}-\\u{26FF}\\u{2700}-\\u{27BF}\\u{2B00}-\\u{2BFF}' +
  '\\u{1F000}-\\u{1F02F}\\u{1F0A0}-\\u{1F0FF}\\u{1F100}-\\u{1F64F}\\u{1F680}-\\u{1F6FF}' +
  '\\u{1F900}-\\u{1F9FF}\\u{1FA00}-\\u{1FA6F}\\u{1FA70}-\\u{1FAFF}]';

// Variant selectors / zero-width joiner / keycap combining mark / tag block —
// matched one-at-a-time so each sits outside any character class.
const EMOJI_MOD = '[\\u{FE00}-\\u{FE0F}]|\\u{200D}|\\u{20E3}|[\\u{E0020}-\\u{E007F}]';

const EMOJI_REGEX = new RegExp(`^((?:${EMOJI_CP}|${EMOJI_MOD})+)\\s*`, 'gu');

export function extractEmoji(text: string): { emoji: string; text: string } {
  const match = text.match(EMOJI_REGEX);

  if (match) {
    const emoji = match[0];
    const remainingText = text.slice(emoji.length).trim();
    return { emoji, text: remainingText };
  }

  return { emoji: '', text };
}
