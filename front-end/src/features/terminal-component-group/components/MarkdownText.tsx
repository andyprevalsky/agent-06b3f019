/**
 * MarkdownText
 *
 * Thin wrapper that normalizes LLM-escape-sequence input and dispatches to one
 * of two render paths:
 *
 *   !shouldAnimate  -> ReactMarkdown
 *   shouldAnimate   -> FadeInMarkdown (word-by-word fade-in)
 *   breaks=true     -> both paths add remarkBreaks (single newlines stay line breaks)
 *
 * Both paths render the same ReactMarkdown tree with MARKDOWN_COMPONENTS, so a
 * reply keeps every GFM node (tables in a scroll container, nested lists,
 * code, links, photos) whether it is fading in, streaming or settled.
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

import { FadeInMarkdown, MARKDOWN_COMPONENTS, normalizeMarkdownText } from './markdown-text';
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
          components={MARKDOWN_COMPONENTS}
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
      breaks={breaks}
    />
  );
});
