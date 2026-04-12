import { useEffect } from 'react';

import { PRIVACY_TITLE, PRIVACY_DESCRIPTION } from './config';

/** Sets document title, meta description, and canonical link for the Privacy page. */
export function usePrivacySeo(): void {
  useEffect(() => {
    document.title = PRIVACY_TITLE;

    const ensureMeta = (name: string, content: string) => {
      let tag = document.querySelector(`meta[name="${name}"]`);
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute('name', name);
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', content);
    };

    ensureMeta('description', PRIVACY_DESCRIPTION);

    let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = window.location.href;
  }, []);
}
