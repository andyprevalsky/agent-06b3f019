import { useEffect } from 'react';

import { ONE_PAGER_TITLE, ONE_PAGER_DESCRIPTION } from './config';

/** Sets document title and meta description for the one-pager page. */
export function useOnePagerSeo(): void {
  useEffect(() => {
    document.title = ONE_PAGER_TITLE;

    const ensureMeta = (name: string, content: string) => {
      let tag = document.querySelector(`meta[name="${name}"]`);
      if (!tag) {
        tag = document.createElement('meta');
        tag.setAttribute('name', name);
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', content);
    };

    ensureMeta('description', ONE_PAGER_DESCRIPTION);
  }, []);
}
