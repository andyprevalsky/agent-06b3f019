/**
 * Block-level renderers: list items, ordered/unordered list wrappers, and
 * regular/special block tags (p, h*, blockquote, pre) with optional fade-in.
 */
import React from 'react';
import { motion } from 'framer-motion';

import { BASE_DELAY_SECONDS, type BlockType, type ListType } from './types';

const TRAILING_WHITESPACE = /^[\s\n]*$/;

function animatedBlockProps(delay: number): Record<string, unknown> {
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    transition: { delay, duration: 0.35, ease: 'easeOut' },
  };
}

export function renderListItem(
  content: React.ReactNode[],
  key: string,
  blockFirstWordIndex: number,
  animate: boolean,
  perWordDelay: number,
): React.ReactNode {
  if (!animate) return <li key={key}>{content}</li>;
  const delay = BASE_DELAY_SECONDS + blockFirstWordIndex * perWordDelay;
  return (
    <motion.li key={key} {...animatedBlockProps(delay)}>
      {content}
    </motion.li>
  );
}

export function renderList(
  listType: ListType,
  items: React.ReactNode[],
  startNum: number | undefined,
  key: string,
): React.ReactNode {
  if (listType === 'ol') {
    if (startNum && startNum > 1) {
      return (
        <ol key={key} start={startNum}>
          {items}
        </ol>
      );
    }
    return <ol key={key}>{items}</ol>;
  }
  return <ul key={key}>{items}</ul>;
}

function trimPreTrailingWhitespace(content: React.ReactNode[]): React.ReactNode[] {
  const trimmed = [...content];
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (React.isValidElement(last) && last.type === React.Fragment) {
      const children = (last.props as { children?: unknown }).children;
      if (typeof children === 'string' && TRAILING_WHITESPACE.test(children)) {
        trimmed.pop();
        continue;
      }
    }
    break;
  }
  return trimmed;
}

export function renderBlock(
  blockType: BlockType,
  content: React.ReactNode[],
  key: string,
  blockFirstWordIndex: number,
  animate: boolean,
  perWordDelay: number,
): React.ReactNode {
  const delay = BASE_DELAY_SECONDS + blockFirstWordIndex * perWordDelay;
  const finalContent = blockType === 'pre' ? trimPreTrailingWhitespace(content) : content;
  const isSpecial = blockType === 'blockquote' || blockType === 'pre';

  if (isSpecial && animate) {
    if (blockType === 'blockquote') {
      return (
        <motion.blockquote key={key} className="custom-blockquote" {...animatedBlockProps(delay)}>
          {finalContent}
        </motion.blockquote>
      );
    }
    return (
      <motion.pre key={key} {...animatedBlockProps(delay)}>
        {finalContent}
      </motion.pre>
    );
  }

  if (blockType === 'blockquote') {
    return (
      <blockquote key={key} className="custom-blockquote">
        {finalContent}
      </blockquote>
    );
  }
  return React.createElement(blockType, { key }, finalContent);
}
