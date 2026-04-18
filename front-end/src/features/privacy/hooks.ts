import { useDocumentSeo } from '@/lib/seo';

import { PRIVACY_TITLE, PRIVACY_DESCRIPTION } from './config';

/** Sets document title, meta description, and canonical link for the Privacy page. */
export function usePrivacySeo(): void {
  useDocumentSeo({
    title: PRIVACY_TITLE,
    description: PRIVACY_DESCRIPTION,
    canonical: true,
  });
}
