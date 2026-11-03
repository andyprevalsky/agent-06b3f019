/** Mac hover opens; back or the right-side window buffer closes. */
import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react';

import { ROSE_BAR_EXPANDED_WIDTH } from './roseSidebarLayout';

export function useSidebarExpansion() {
  const sticky =
    (window as typeof window & { api?: { isElectron?: boolean } }).api?.isElectron === true ||
    /^Mac/.test(navigator.platform);
  const suppressHover = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const close = useCallback(() => {
    suppressHover.current = true;
    setHovered(false);
    setMenuOpen(false);
    setTyping(false);
  }, []);
  useEffect(() => {
    if (!sticky || !hovered || typing || menuOpen) return;
    const beyondRightBuffer = (event: MouseEvent) => {
      if (event.clientX > ROSE_BAR_EXPANDED_WIDTH + window.innerWidth * 0.1) {
        close();
        // Auto-close happens outside the drawer; the next entry is a fresh hover.
        suppressHover.current = false;
      }
    };
    window.addEventListener('mousemove', beyondRightBuffer);
    return () => window.removeEventListener('mousemove', beyondRightBuffer);
  }, [close, hovered, menuOpen, sticky, typing]);
  const isTextInput = (el: EventTarget | null) => el instanceof HTMLInputElement;
  return {
    sticky,
    isExpanded: hovered || menuOpen || typing,
    setMenuOpen,
    close,
    surface: {
      onMouseEnter: () => {
        if (!suppressHover.current) setHovered(true);
      },
      onMouseLeave: () => {
        suppressHover.current = false;
        if (!sticky) setHovered(false);
      },
      onFocus: (e: FocusEvent) => setTyping(isTextInput(e.target)),
      onBlur: (e: FocusEvent) => setTyping(isTextInput(e.relatedTarget)),
    },
  };
}
