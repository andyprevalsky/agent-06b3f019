/**
 * Turn a flat list of WordItem into a JSX tree of blocks and inline groups
 * with optional word-by-word fade-in animation.
 *
 * The algorithm is a streaming state machine that accumulates:
 *   1. Inline groups (consecutive words sharing bold/italic/code/link formatting)
 *   2. Block content (paragraphs, headings, list items, blockquotes, pre)
 *   3. Lists (ul/ol wrappers that batch consecutive <li> children)
 *
 * On every block-boundary transition, it flushes the inline group, then the
 * block, then (when appropriate) the accumulated list.
 */
import React from 'react';

import { renderBlock, renderList, renderListItem } from './renderBlocks';
import { renderInlineGroup, type WordIndexRef } from './renderInlineGroup';
import { type ListType, type WordItem } from './types';

interface RenderState {
  animate: boolean;
  perWordDelay: number;
  lastWordItem: WordItem | null;
  wordIndexRef: WordIndexRef;
  onLastWordComplete: () => void;

  elements: React.ReactNode[];
  currentBlock: React.ReactNode[];
  currentBlockType: string | undefined;
  currentBlockIndex: number | undefined;
  currentBlockFirstWordIndex: number;

  listItems: React.ReactNode[];
  currentListType: ListType | undefined;
  olItemCount: number;
  olStartNumber: number;

  inlineGroup: WordItem[];
  lastFormatting: string;
  inlineGroupFirstWordIndex: number;
}

function createState(
  animate: boolean,
  perWordDelay: number,
  lastWordItem: WordItem | null,
  onLastWordComplete: () => void,
): RenderState {
  return {
    animate,
    perWordDelay,
    lastWordItem,
    wordIndexRef: { value: 0 },
    onLastWordComplete,
    elements: [],
    currentBlock: [],
    currentBlockType: undefined,
    currentBlockIndex: undefined,
    currentBlockFirstWordIndex: 0,
    listItems: [],
    currentListType: undefined,
    olItemCount: 0,
    olStartNumber: 1,
    inlineGroup: [],
    lastFormatting: '',
    inlineGroupFirstWordIndex: 0,
  };
}

function flushInlineGroup(s: RenderState): void {
  if (s.inlineGroup.length === 0) return;
  const rendered = renderInlineGroup({
    group: s.inlineGroup,
    groupKey: `group-${s.currentBlock.length}`,
    groupFirstWordIndex: s.inlineGroupFirstWordIndex,
    wordIndexRef: s.wordIndexRef,
    lastWordItem: s.lastWordItem,
    animate: s.animate,
    perWordDelay: s.perWordDelay,
    onLastWordComplete: s.onLastWordComplete,
  });
  if (rendered) s.currentBlock.push(rendered);
  s.inlineGroup = [];
}

function flushList(s: RenderState): void {
  if (s.listItems.length === 0 || !s.currentListType) return;
  s.elements.push(
    renderList(s.currentListType, s.listItems, s.olStartNumber, `list-${s.elements.length}`),
  );
  if (s.currentListType === 'ol') s.olStartNumber = s.olItemCount + 1;
  s.listItems = [];
  s.currentListType = undefined;
}

function pushCurrentListItem(s: RenderState): void {
  s.listItems.push(
    renderListItem(
      s.currentBlock,
      `li-${s.listItems.length}`,
      s.currentBlockFirstWordIndex,
      s.animate,
      s.perWordDelay,
    ),
  );
  if (s.currentListType === 'ol') s.olItemCount += 1;
  s.currentBlock = [];
}

function pushCurrentBlock(s: RenderState): void {
  if (!s.currentBlockType) {
    s.elements.push(...s.currentBlock);
    s.currentBlock = [];
    return;
  }
  s.elements.push(
    renderBlock(
      s.currentBlockType as Parameters<typeof renderBlock>[0],
      s.currentBlock,
      `block-${s.elements.length}`,
      s.currentBlockFirstWordIndex,
      s.animate,
      s.perWordDelay,
    ),
  );
  s.currentBlock = [];
}

function finishCurrentBlock(s: RenderState, isNextListItem: boolean): void {
  flushInlineGroup(s);
  s.lastFormatting = '';

  if (s.currentBlockType === 'li') {
    pushCurrentListItem(s);
    if (!isNextListItem) flushList(s);
    return;
  }

  flushList(s);
  pushCurrentBlock(s);
}

function handleWhitespaceItem(s: RenderState, item: WordItem, index: number): void {
  const first = s.inlineGroup[0];
  const keepInGroup =
    !!first && ((first.isCode && first.blockType !== 'pre') || first.isLink);

  if (keepInGroup) {
    s.inlineGroup.push(item);
    return;
  }
  flushInlineGroup(s);
  s.lastFormatting = '';
  s.currentBlock.push(<React.Fragment key={index}>{item.word}</React.Fragment>);
}

function formattingKey(item: WordItem): string {
  return `${item.isBold || ''}-${item.isItalic || ''}-${item.isCode || ''}-${item.isLink || ''}-${item.href || ''}`;
}

function maybeSwitchListType(s: RenderState, item: WordItem): void {
  if (item.blockType !== 'li' || !item.listType) return;
  if (s.currentListType && s.currentListType !== item.listType && s.listItems.length > 0) {
    flushList(s);
  }
  s.currentListType = item.listType;
}

function handleWordItem(s: RenderState, item: WordItem): void {
  const shouldStartNewBlock =
    !!item.blockType &&
    item.blockIndex !== s.currentBlockIndex &&
    s.currentBlock.length > 0;

  if (shouldStartNewBlock) finishCurrentBlock(s, item.blockType === 'li');

  maybeSwitchListType(s, item);
  s.currentBlockType = item.blockType;
  s.currentBlockIndex = item.blockIndex;

  if (s.currentBlock.length === 0) s.currentBlockFirstWordIndex = s.wordIndexRef.value;

  const nextFormatting = formattingKey(item);
  if (nextFormatting !== s.lastFormatting && s.inlineGroup.length > 0) {
    flushInlineGroup(s);
  }
  s.lastFormatting = nextFormatting;
  if (s.inlineGroup.length === 0) s.inlineGroupFirstWordIndex = s.wordIndexRef.value;
  s.inlineGroup.push(item);
}

function finalFlush(s: RenderState): void {
  flushInlineGroup(s);
  if (s.currentBlock.length > 0) {
    if (s.currentBlockType === 'li') {
      pushCurrentListItem(s);
    } else {
      flushList(s);
      pushCurrentBlock(s);
    }
  }
  if (s.listItems.length > 0 && s.currentListType) flushList(s);
}

export function renderWords(
  words: WordItem[],
  animate: boolean,
  perWordDelay: number,
  lastWordItem: WordItem | null,
  onLastWordComplete: () => void,
): React.ReactNode[] {
  const s = createState(animate, perWordDelay, lastWordItem, onLastWordComplete);

  words.forEach((item, index) => {
    if (!item.isWord) handleWhitespaceItem(s, item, index);
    else handleWordItem(s, item);
  });

  finalFlush(s);
  return s.elements;
}
