import { useEffect, useState } from 'react';

import { ABOUT_TITLE, ABOUT_DESCRIPTION } from './config';

/** Sets document title, meta description, and canonical link for the About page. */
export function useAboutSeo(): void {
  useEffect(() => {
    document.title = ABOUT_TITLE;

    const ensureMeta = (name: string, content: string) => {
      let tag = document.querySelector(`meta[name="${name}"]`);
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute('name', name);
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', content);
    };

    ensureMeta('description', ABOUT_DESCRIPTION);

    let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    link.href = window.location.href;
  }, []);
}

/** Manages the contact modal open/close state. */
export function useContactModal() {
  const [contactOpen, setContactOpen] = useState(false);
  return { contactOpen, setContactOpen } as const;
}
