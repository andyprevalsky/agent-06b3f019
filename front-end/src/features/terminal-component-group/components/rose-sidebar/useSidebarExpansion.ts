/** Mac desktop hover stays open until the pointer returns to the window's left edge. */
import { useEffect, useState, type FocusEvent } from 'react';

export function useSidebarExpansion() {
  const sticky =
    (window as typeof window & { api?: { isElectron?: boolean } }).api?.isElectron === true ||
    /^Mac/.test(navigator.platform);
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!sticky) return;
    const collapseAtEdge = (event: MouseEvent) => {
      if (event.clientX <= 8) setHovered(false);
    };
    window.addEventListener('mousemove', collapseAtEdge);
    return () => window.removeEventListener('mousemove', collapseAtEdge);
  }, [sticky]);
  const isTextInput = (el: EventTarget | null) => el instanceof HTMLInputElement;
  return {
    sticky,
    isExpanded: hovered || menuOpen || typing,
    setMenuOpen,
    surface: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: () => {
        if (!sticky) setHovered(false);
      },
      onFocus: (e: FocusEvent) => setTyping(isTextInput(e.target)),
      onBlur: (e: FocusEvent) => setTyping(isTextInput(e.relatedTarget)),
    },
  };
}
