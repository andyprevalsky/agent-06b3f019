import { useEffect } from 'react';

import { TERMS_TITLE, TERMS_DESCRIPTION } from './config';

/** Sets document title, meta description, and canonical link for the Terms page. */
export function useTermsSeo(): void {
  useEffect(() => {
    document.title = TERMS_TITLE;

    const ensureMeta = (name: string, content: string) => {
      let tag = document.querySelector(`meta[name="${name}"]`);
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute('name', name);
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', content);
    };

    ensureMeta('description', TERMS_DESCRIPTION);

    let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = window.location.href;
  }, []);
}
