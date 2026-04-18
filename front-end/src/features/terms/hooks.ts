import { useDocumentSeo } from '@/lib/seo';

import { TERMS_TITLE, TERMS_DESCRIPTION } from './config';

/** Sets document title, meta description, and canonical link for the Terms page. */
export function useTermsSeo(): void {
  useDocumentSeo({
    title: TERMS_TITLE,
    description: TERMS_DESCRIPTION,
    canonical: true,
  });
}
