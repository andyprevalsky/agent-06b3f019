/**
 * MarkdownText
 *
 * Thin wrapper that normalizes LLM-escape-sequence input and dispatches to one
 * of two render paths:
 *
 *   breaks=true && !shouldAnimate  -> ReactMarkdown + remarkBreaks (static; the
 *                                     FadeInMarkdown DOM-extraction pipeline
 *                                     does not preserve <br> from remark-breaks)
 *   otherwise                      -> FadeInMarkdown (word-by-word fade-in)
 *
 * See `./markdown-text/FadeInMarkdown.tsx` for the animation state machine.
 */
import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

import { cn } from '@/lib/utils';

import { FadeInMarkdown, normalizeMarkdownText } from './markdown-text';
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

  if (breaks && !shouldAnimate) {
    return (
      <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
        <MarkdownStyles />
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{normalizedText}</ReactMarkdown>
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
