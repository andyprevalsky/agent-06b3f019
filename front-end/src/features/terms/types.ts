/** A single bullet point within a terms section (e.g., SMS message types). */
export interface TermsBullet {
  readonly text: string;
}

/** A content block within a terms section — either a paragraph or a list of bullets. */
export interface TermsContentBlock {
  readonly kind: 'paragraph' | 'bullets';
  /** Plain text paragraph (when kind === 'paragraph'). */
  readonly text?: string;
  /** Bold prefix rendered before the rest of the text (when kind === 'paragraph'). */
  readonly boldPrefix?: string;
  /** Bullet items (when kind === 'bullets'). */
  readonly items?: readonly TermsBullet[];
}

/** A section of the terms of service (numbered heading + one or more content blocks). */
export interface TermsSection {
  readonly number: number;
  readonly title: string;
  /** Ordered list of content blocks rendered sequentially. */
  readonly blocks: readonly TermsContentBlock[];
}
