/**
 * MarkdownText
 *
 * Thin wrapper that normalizes LLM-escape-sequence input and dispatches to one
 * of two render paths:
 *
 *   !shouldAnimate  -> ReactMarkdown (+ remarkBreaks when breaks=true).
 *                      Static FYI / tool / plan bubbles keep every GFM node,
 *                      including photos. FadeInMarkdown's word extractor is
 *                      text-only and must not own the static path.
 *   shouldAnimate   -> FadeInMarkdown (word-by-word fade-in, including images)
 *
 * STATE MACHINE:
 *   [STATIC]     -- shouldAnimate=false --> ReactMarkdown
 *   [ANIMATING]  -- shouldAnimate=true  --> FadeInMarkdown
 *
 * See `./markdown-text/FadeInMarkdown.tsx` for the animation state machine.
 */
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

import { cn } from '@/lib/utils';

import { FadeInMarkdown, MarkdownLink, normalizeMarkdownText } from './markdown-text';
import { MarkdownStyles } from './markdown-text/MarkdownStyles';

interface MarkdownTextProps {
  text: string;
  shouldAnimate?: boolean;
  onComplete?: () => void;
  className?: string;
  breaks?: boolean;
}

export const MarkdownText = memo(function MarkdownText({
  text,
  shouldAnimate = false,
  onComplete,
  className,
  breaks = false,
}: MarkdownTextProps) {
  const normalizedText = normalizeMarkdownText(text);

  if (!shouldAnimate) {
    return (
      <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
        <MarkdownStyles />
        <ReactMarkdown
          remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
          components={{ a: MarkdownLink }}
        >
          {normalizedText}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <FadeInMarkdown
      markdown={normalizedText}
      onComplete={onComplete}
      className={className}
      shouldAnimate={shouldAnimate}
    />
  );
});
