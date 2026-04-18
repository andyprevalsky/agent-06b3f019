import { useState } from 'react';

import { useDocumentSeo } from '@/lib/seo';

import { ABOUT_TITLE, ABOUT_DESCRIPTION } from './config';

/** Sets document title, meta description, and canonical link for the About page. */
export function useAboutSeo(): void {
  useDocumentSeo({
    title: ABOUT_TITLE,
    description: ABOUT_DESCRIPTION,
    canonical: true,
  });
}

/** Manages the contact modal open/close state. */
export function useContactModal() {
  const [contactOpen, setContactOpen] = useState(false);
  return { contactOpen, setContactOpen } as const;
}
