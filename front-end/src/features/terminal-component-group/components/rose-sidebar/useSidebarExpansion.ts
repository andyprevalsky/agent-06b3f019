/** Mac hover opens and latches; the back button closes. Other desktops retain ordinary hover. */
import { useRef, useState, type FocusEvent } from 'react';

export function useSidebarExpansion() {
  const sticky =
    (window as typeof window & { api?: { isElectron?: boolean } }).api?.isElectron === true ||
    /^Mac/.test(navigator.platform);
  const suppressHover = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const isTextInput = (el: EventTarget | null) => el instanceof HTMLInputElement;
  return {
    sticky,
    isExpanded: hovered || menuOpen || typing,
    setMenuOpen,
    close: () => {
      suppressHover.current = true;
      setHovered(false);
      setMenuOpen(false);
      setTyping(false);
    },
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
