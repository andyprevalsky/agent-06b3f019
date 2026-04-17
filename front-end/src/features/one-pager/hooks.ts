import { useDocumentSeo } from '@/lib/seo';

import { ONE_PAGER_TITLE, ONE_PAGER_DESCRIPTION } from './config';

/** Sets document title and meta description for the one-pager page. */
export function useOnePagerSeo(): void {
  useDocumentSeo({
    title: ONE_PAGER_TITLE,
    description: ONE_PAGER_DESCRIPTION,
  });
}
