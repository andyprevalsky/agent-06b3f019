/**
 * Types and animation constants for the MarkdownText render pipeline.
 */

export type BlockType = 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'li' | 'blockquote' | 'pre';

export type ListType = 'ul' | 'ol';

export interface WordItem {
  word: string;
  isWord: boolean;
  isBold?: boolean;
  isItalic?: boolean;
  isLink?: boolean;
  href?: string;
  isCode?: boolean;
  /** Block element this word belongs to. */
  blockType?: BlockType;
  /** Unique index for each block element instance. */
  blockIndex?: number;
  /** Parent list type for li elements. */
  listType?: ListType;
}

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
