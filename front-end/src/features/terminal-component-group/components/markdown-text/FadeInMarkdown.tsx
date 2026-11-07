/**
 * FadeInMarkdown
 *
 * Animated markdown: the same ReactMarkdown tree and component map as the
 * static path (tables, nested lists, headings, code, links, images), with each
 * word fading in after a staggered delay (rehypeFadeWords).
 *
 * STATE MACHINE:
 *   [FADING]    mount / markdown change -> a new generation; every word of the
 *               rendered tree fades in, word i at BASE + i * perWordDelay
 *   [COMPLETE]  last word's fade ends -> props.onComplete(), only while this
 *               generation is the committed, mounted one
 *   [STATIC]    reduced motion -> same tree without fades; completes on commit
 *
 * Retired generations (a replaced markdown, a discarded render, an unmount)
 * never call onComplete.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { useReducedMotion } from 'framer-motion';

import { cn } from '@/lib/utils';

import { createFadeWordSpan, rehypeFadeWords } from './fadeWords';
import { MARKDOWN_COMPONENTS } from './markdownComponents';
import { MarkdownStyles } from './MarkdownStyles';

interface FadeInMarkdownProps {
  markdown: string;
  onComplete?: () => void;
  className?: string;
  shouldAnimate?: boolean;
  breaks?: boolean;
}

const REMARK_PLUGINS = [remarkGfm];
const REMARK_PLUGINS_WITH_BREAKS = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS = [rehypeFadeWords];

export function FadeInMarkdown({
  markdown,
  onComplete,
  className,
  shouldAnimate = true,
  breaks = false,
}: FadeInMarkdownProps): JSX.Element {
  const reduce = useReducedMotion();
  const animate = !!shouldAnimate && !reduce;
  const generation = useMemo(() => ({ markdown }), [markdown]);
  const owner = useRef<{ generation: typeof generation; onComplete?: () => void } | null>(null);
  useLayoutEffect(() => {
    owner.current = { generation, onComplete };
  }, [generation, onComplete]);
  useLayoutEffect(
    () => () => {
      owner.current = null;
    },
    [],
  );

  const components = useMemo(() => {
    const complete = (): void => {
      if (owner.current?.generation === generation) owner.current.onComplete?.();
    };
    return { ...MARKDOWN_COMPONENTS, span: createFadeWordSpan(complete) };
  }, [generation]);

  useEffect(() => {
    if (!animate && owner.current?.generation === generation) owner.current.onComplete?.();
  }, [animate, generation]);

  return (
    <div className={cn('prose prose-sm dark:prose-invert max-w-none', className)}>
      <MarkdownStyles />
      <ReactMarkdown
        remarkPlugins={breaks ? REMARK_PLUGINS_WITH_BREAKS : REMARK_PLUGINS}
        rehypePlugins={animate ? REHYPE_PLUGINS : undefined}
        components={animate ? components : MARKDOWN_COMPONENTS}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
