/**
 * Walks a rendered-markdown DOM subtree and extracts words/whitespace with
 * their inline + block formatting metadata. The output is the input to the
 * word-by-word fade-in renderer.
 */

import { type BlockType, type ListType, type WordItem } from './types';

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'pre',
]);

function pushText(text: string, formatting: Partial<WordItem>, out: WordItem[]): void {
  if (text.trim().length === 0) {
    out.push({ word: text, isWord: false, ...formatting });
    return;
  }
  const parts = text.split(/(\s+)/);
  for (const part of parts) {
    if (part.length === 0) continue;
    const isWord = part.trim().length > 0;
    out.push({ word: part, isWord, ...formatting });
  }
}

function applyInlineFormatting(
  tagName: string,
  element: HTMLElement,
  formatting: Partial<WordItem>,
): Partial<WordItem> {
  const next: Partial<WordItem> = { ...formatting };
  if (tagName === 'strong' || tagName === 'b') next.isBold = true;
  if (tagName === 'em' || tagName === 'i') next.isItalic = true;
  if (tagName === 'a') {
    next.isLink = true;
    next.href = element.getAttribute('href') || undefined;
  }
  if (tagName === 'code') next.isCode = true;
  return next;
}

function applyBlockFormatting(
  tagName: string,
  existing: Partial<WordItem>,
  allocBlockIndex: () => number,
): Partial<WordItem> {
  const next: Partial<WordItem> = { ...existing };
  if (BLOCK_TAGS.has(tagName)) {
    next.blockType = tagName as BlockType;
    next.blockIndex = allocBlockIndex();
  } else if (tagName === 'p' && !existing.blockType) {
    next.blockType = 'p';
    next.blockIndex = allocBlockIndex();
  }
  if (tagName === 'ul' || tagName === 'ol') {
    next.listType = tagName as ListType;
  }
  return next;
}

/** Extract a flat, in-order list of WordItem from a rendered-markdown root. */
export function extractWords(root: Node): WordItem[] {
  const out: WordItem[] = [];
  let blockIndexCounter = 0;
  const allocBlockIndex = (): number => blockIndexCounter++;

  const walk = (node: Node, formatting: Partial<WordItem>): void => {
    if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      pushText(node.textContent, formatting, out);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as HTMLElement;
    const tagName = element.tagName.toLowerCase();
    const withInline = applyInlineFormatting(tagName, element, formatting);
    const withBlock = applyBlockFormatting(tagName, withInline, allocBlockIndex);

    for (const child of Array.from(node.childNodes)) walk(child, withBlock);
  };

  walk(root, {});
  return out;
}
