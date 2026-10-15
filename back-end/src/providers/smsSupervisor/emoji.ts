import { UNICODE_EMOJI_MODIFIER_BASE } from './unicodeEmojiModifierBases';

// Unicode sequence structure, rather than a palette of permitted reactions.
const EMOJI_COMPONENT = `(?:${UNICODE_EMOJI_MODIFIER_BASE}\\uFE0F?\\p{Emoji_Modifier}|\\p{Extended_Pictographic}\\uFE0F?)`;
const EMOJI_SEQUENCE = `(?:${EMOJI_COMPONENT}(?:\\u200D${EMOJI_COMPONENT})*|\\p{Regional_Indicator}{2}|[0-9#*]\\uFE0F?\\u20E3|\\u{1F3F4}[\\u{E0061}-\\u{E007A}]+\\u{E007F})`;
const SINGLE_EMOJI = new RegExp(`^${EMOJI_SEQUENCE}$`, 'u');
const EMOJI_ONLY_MESSAGE = new RegExp(`^(?:${EMOJI_SEQUENCE}\\s*)+$`, 'u');

export function isSingleEmoji(value: unknown): value is string {
  return typeof value === 'string' && SINGLE_EMOJI.test(value);
}

export function isEmojiOnlyMessage(value: string): boolean {
  return EMOJI_ONLY_MESSAGE.test(value.trim());
}
