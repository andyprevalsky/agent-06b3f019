/**
 * Word-by-word fade for FadeInMarkdown, applied to the real ReactMarkdown tree.
 *
 * rehypeFadeWords wraps every word (and image) of the rendered hast in a span
 * carrying its fade delay, and marks the last one, so tables, nested lists,
 * headings and code blocks keep their structure while they fade in.
 * createFadeWordSpan renders those spans as motion spans; the last one reports
 * completion.
 */
import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

import { BASE_DELAY_SECONDS, FADE_DURATION_SECONDS, computePerWordDelay } from './types';

interface HastText {
  type: 'text';
  value: string;
}
interface HastElement {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: 'comment' | 'doctype' | 'raw'; value?: string };
interface HastParent {
  children: HastNode[];
}

function fadeSpan(child: HastNode): HastElement {
  return { type: 'element', tagName: 'span', properties: {}, children: [child] };
}

/** Rehype plugin: one fade span per word / image, delays staggered across the reply. */
export function rehypeFadeWords() {
  return (tree: HastParent): void => {
    const spans: HastElement[] = [];
    const visit = (parent: HastParent): void => {
      parent.children = parent.children.flatMap((child): HastNode[] => {
        if (child.type === 'text') {
          return child.value
            .split(/(\s+)/)
            .filter((part) => part.length > 0)
            .map((part) => {
              if (part.trim().length === 0) return { type: 'text', value: part };
              const span = fadeSpan({ type: 'text', value: part });
              spans.push(span);
              return span;
            });
        }
        if (child.type !== 'element') return [child];
        if (child.tagName === 'img') {
          const span = fadeSpan(child);
          spans.push(span);
          return [span];
        }
        visit(child);
        return [child];
      });
    };
    visit(tree);
    const perWordDelay = computePerWordDelay(spans.length);
    spans.forEach((span, index) => {
      span.properties = { dataFadeDelay: BASE_DELAY_SECONDS + index * perWordDelay };
      if (index === spans.length - 1) span.properties.dataFadeLast = 'true';
    });
  };
}

interface FadeWordSpanProps {
  children?: ReactNode;
  'data-fade-delay'?: number | string;
  'data-fade-last'?: string;
}

/** The `span` renderer for a fading reply; the last word calls onLastWordComplete. */
export function createFadeWordSpan(onLastWordComplete: () => void) {
  return function FadeWordSpan(props: FadeWordSpanProps) {
    const delay = props['data-fade-delay'];
    if (delay === undefined) return <span>{props.children}</span>;
    return (
      <motion.span
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: Number(delay), duration: FADE_DURATION_SECONDS, ease: 'easeOut' }}
        onAnimationComplete={props['data-fade-last'] ? onLastWordComplete : undefined}
      >
        {props.children}
      </motion.span>
    );
  };
}
