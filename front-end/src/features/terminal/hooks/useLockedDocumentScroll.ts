import { useEffect } from 'react';

export const LOCKED_DOCUMENT_SCROLL_CLASS = 'rose-app-shell';

/**
 * The terminal shell is a fixed 100dvh column whose panes scroll internally,
 * so the document itself must never scroll. Without this lock, mobile Safari
 * chains a pane's scroll (and its rubber-band bounce) to the page, dragging
 * the query box with it and toggling the toolbar, which resizes 100dvh.
 * index.css styles html.rose-app-shell; other routes keep document scroll.
 */
export function useLockedDocumentScroll(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(LOCKED_DOCUMENT_SCROLL_CLASS);
    return () => root.classList.remove(LOCKED_DOCUMENT_SCROLL_CLASS);
  }, []);
}
