/**
 * Canonical SEO hook — sets document title, meta description, and canonical link.
 * Domain code must import from here instead of poking document.title /
 * document.createElement('meta') directly — enforced via `no-restricted-syntax`.
 */

import { useEffect } from 'react';

interface DocumentSeoOptions {
  title: string;
  description?: string;
  /** When true, sets <link rel="canonical"> to the current window.location.href. */
  canonical?: boolean;
}

function ensureMeta(name: string, content: string): void {
  let tag = document.querySelector(`meta[name="${name}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute('name', name);
    document.head.appendChild(tag);
  }
  tag.setAttribute('content', content);
}

function ensureCanonical(): void {
  let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.rel = 'canonical';
    document.head.appendChild(link);
  }
  link.href = window.location.href;
}

export function useDocumentSeo({ title, description, canonical }: DocumentSeoOptions): void {
  useEffect(() => {
    document.title = title;

    if (description !== undefined) {
      ensureMeta('description', description);
    } else {
      document.querySelector('meta[name="description"]')?.remove();
    }

    if (canonical) {
      ensureCanonical();
    } else {
      document.querySelector('link[rel="canonical"]')?.remove();
    }
  }, [title, description, canonical]);
}
