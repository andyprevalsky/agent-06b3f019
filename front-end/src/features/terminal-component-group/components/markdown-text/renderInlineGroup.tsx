/**
 * Renders a group of consecutive words that share the same inline formatting
 * (bold, italic, code, link). Handles the tricky case of inline code that
 * needs its leading/trailing whitespace rendered *outside* the <code> element.
 */
import React from 'react';
import { motion } from 'framer-motion';

import { BASE_DELAY_SECONDS, FADE_DURATION_SECONDS, type WordItem } from './types';

export interface WordIndexRef {
  value: number;
}

export interface RenderInlineGroupArgs {
  group: WordItem[];
  groupKey: string;
  groupFirstWordIndex: number;
  wordIndexRef: WordIndexRef;
  lastWordItem: WordItem | null;
  animate: boolean;
  perWordDelay: number;
  onLastWordComplete: () => void;
}

function wrapInlineFormatting(
  firstItem: WordItem,
  wordSpans: React.ReactNode[],
  groupKey: string,
  animate: boolean,
  delay: number,
): React.ReactNode {
  let content: React.ReactNode = <React.Fragment key={groupKey}>{wordSpans}</React.Fragment>;

  if (firstItem.isCode) {
    if (firstItem.blockType !== 'pre' && animate) {
      return (
        <motion.code
          key={groupKey}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay, duration: 0.35, ease: 'easeOut' }}
        >
          {wordSpans}
        </motion.code>
      );
    }
    return <code key={groupKey}>{wordSpans}</code>;
  }

  if (firstItem.isBold) content = <strong key={groupKey}>{wordSpans}</strong>;
  if (firstItem.isItalic) content = <em key={`${groupKey}-em`}>{content}</em>;
  if (firstItem.isLink && firstItem.href) {
    content = (
      <a key={`${groupKey}-link`} href={firstItem.href}>
        {content}
      </a>
    );
  }
  return content;
}

function splitInlineCodeWhitespace(group: WordItem[]): {
  inner: WordItem[];
  leading: WordItem | null;
  trailing: WordItem | null;
} {
  const inner = [...group];
  let leading: WordItem | null = null;
  let trailing: WordItem | null = null;
  if (inner.length > 0 && !inner[0].isWord) leading = inner.shift()!;
  if (inner.length > 0 && !inner[inner.length - 1].isWord) trailing = inner.pop()!;
  return { inner, leading, trailing };
}

function renderWordSpan(
  item: WordItem,
  idx: number,
  currentWordIndex: number,
  animate: boolean,
  perWordDelay: number,
  isLastWord: boolean,
  onLastWordComplete: () => void,
): React.ReactNode {
  if (animate) {
    const delay = BASE_DELAY_SECONDS + currentWordIndex * perWordDelay;
    return (
      <motion.span
        key={`word-${idx}`}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay, duration: FADE_DURATION_SECONDS, ease: 'easeOut' }}
        onAnimationComplete={isLastWord ? onLastWordComplete : undefined}
      >
        {item.word}
      </motion.span>
    );
  }
  return <span key={`word-${idx}`}>{item.word}</span>;
}

export function renderInlineGroup(args: RenderInlineGroupArgs): React.ReactNode {
  const {
    group,
    groupKey,
    groupFirstWordIndex,
    wordIndexRef,
    lastWordItem,
    animate,
    perWordDelay,
    onLastWordComplete,
  } = args;

  if (group.length === 0) return null;

  const firstItem = group[0];
  const isInlineCode = !!firstItem.isCode && firstItem.blockType !== 'pre';
  const { inner, leading, trailing } = isInlineCode
    ? splitInlineCodeWhitespace(group)
    : { inner: group, leading: null, trailing: null };

  const wordSpans = inner.map((item, idx) => {
    const currentWordIndex = wordIndexRef.value;
    if (item.isWord) wordIndexRef.value += 1;
    return renderWordSpan(
      item,
      idx,
      currentWordIndex,
      animate,
      perWordDelay,
      item === lastWordItem,
      onLastWordComplete,
    );
  });

  const groupDelay = BASE_DELAY_SECONDS + groupFirstWordIndex * perWordDelay;
  const wrapped = wrapInlineFormatting(firstItem, wordSpans, groupKey, animate, groupDelay);

  if (!isInlineCode) return wrapped;
  return (
    <React.Fragment key={groupKey}>
      {leading && leading.word}
      {wrapped}
      {trailing && trailing.word}
    </React.Fragment>
  );
}
