/**
 * FadeInMarkdown
 *
 * Animated markdown that fades in word-by-word while preserving markdown
 * formatting (bold, italic, code, links, lists, blockquotes, code blocks).
 *
 * STATE MACHINE:
 *   [MOUNT]
 *     -> renders a hidden ReactMarkdown tree into `tempRef`
 *     -> useEffect walks the DOM via extractWords() and populates `words`
 *   [EXTRACTED] (words.length > 0)
 *     -> renders words via renderWords() with/without fade-in animation
 *     -> last animated word fires onAnimationComplete -> props.onComplete()
 *
 * State:
 *   - words: WordItem[]   (flat, in-order list of words + whitespace + metadata)
 */
import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useReducedMotion } from 'framer-motion';

import { cn } from '@/lib/utils';

import { extractWords } from './extractWords';
import { MarkdownStyles } from './MarkdownStyles';
import { renderWords } from './renderWords';
import { computePerWordDelay, type WordItem } from './types';

interface FadeInMarkdownProps {
  markdown: string;
  onComplete?: () => void;
  className?: string;
  shouldAnimate?: boolean;
}

function findLastWord(words: WordItem[]): WordItem | null {
  for (let i = words.length - 1; i >= 0; i -= 1) {
    if (words[i].isWord) return words[i];
  }
  return null;
}

export function FadeInMarkdown({
  markdown,
  onComplete,
  className,
  shouldAnimate = true,
}: FadeInMarkdownProps): JSX.Element {
  const reduce = useReducedMotion();
  const tempRef = useRef<HTMLDivElement>(null);
  const [words, setWords] = useState<WordItem[]>([]);

  useEffect(() => {
    if (!tempRef.current) return;
    setWords(extractWords(tempRef.current));
  }, [markdown]);

  if (words.length === 0) {
    return (
      <div ref={tempRef} style={{ position: 'absolute', opacity: 0, pointerEvents: 'none' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    );
  }

  const wordCount = words.filter((w) => w.isWord).length;
  const perWordDelay = computePerWordDelay(wordCount);
  const lastWordItem = findLastWord(words);
  const animate = !!shouldAnimate && !reduce;
  const handleLastWordComplete = (): void => {
    if (onComplete) onComplete();
  };

  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
      <MarkdownStyles />
      {renderWords(words, animate, perWordDelay, lastWordItem, handleLastWordComplete)}
    </div>
  );
}
