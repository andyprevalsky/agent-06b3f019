/**
 * Outbound markdown <a>: http(s) only, new tab, no opener.
 * Electron's will-navigate / setWindowOpenHandler then openExternal.
 */
import type { AnchorHTMLAttributes, ReactNode } from 'react';

function isSafeHttpHref(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const url = new URL(href, 'https://invalid.invalid');
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

interface MarkdownLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href?: string;
  children?: ReactNode;
}

export function MarkdownLink({ href, children, ...props }: MarkdownLinkProps) {
  if (!isSafeHttpHref(href)) {
    return <>{children}</>;
  }
  return (
    <a {...props} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
