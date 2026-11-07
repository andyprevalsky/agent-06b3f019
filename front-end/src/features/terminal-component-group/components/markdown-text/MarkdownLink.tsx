/**
 * Outbound markdown <a>: http(s) only, new tab, no opener.
 * Electron's will-navigate / setWindowOpenHandler then openExternal.
 * Only href / title / children reach the DOM: ReactMarkdown also passes its
 * hast `node`, which must never be spread onto the anchor.
 */
import type { ReactNode } from 'react';

function isSafeHttpHref(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const url = new URL(href, 'https://invalid.invalid');
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

interface MarkdownLinkProps {
  href?: string;
  title?: string;
  children?: ReactNode;
}

export function MarkdownLink({ href, title, children }: MarkdownLinkProps) {
  if (!isSafeHttpHref(href)) {
    return <>{children}</>;
  }
  return (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
