/** Mac desktop hover stays open until the pointer returns to the window's left edge. */
import { useEffect, useRef, useState, type FocusEvent, type PointerEvent } from 'react';

export function useSidebarExpansion() {
  const sticky =
    (window as typeof window & { api?: { isElectron?: boolean } }).api?.isElectron === true ||
    /^Mac/.test(navigator.platform);
  const closeArmed = useRef(false);
  const suppressOpen = useRef(false);
  const expandedRef = useRef(false);
  const dragStart = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    if (!sticky) return;
    const collapse = () => {
      setHovered(false);
      expandedRef.current = false;
      closeArmed.current = false;
      suppressOpen.current = true;
    };
    const collapseAtEdge = (event: MouseEvent) => {
      const inZone = event.clientX <= window.innerWidth * 0.18;
      if (!inZone) suppressOpen.current = false;
      const onControl =
        event.target instanceof Element &&
        event.target.closest('button, input, textarea, a, [role="button"]');
      if (closeArmed.current && inZone && !onControl) collapse();
    };
    const drag = (event: globalThis.PointerEvent) => {
      if (dragStart.current !== null && event.clientX <= dragStart.current - 48) {
        collapse();
        dragStart.current = null;
      }
    };
    const end = () => {
      dragStart.current = null;
    };
    window.addEventListener('mousemove', collapseAtEdge);
    window.addEventListener('pointermove', drag);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      window.removeEventListener('mousemove', collapseAtEdge);
      window.removeEventListener('pointermove', drag);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [sticky]);
  const isTextInput = (el: EventTarget | null) => el instanceof HTMLInputElement;
  return {
    sticky,
    isExpanded: hovered || menuOpen || typing,
    setMenuOpen,
    surface: {
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        if (!sticky || event.button !== 0) return;
        if (
          event.target instanceof Element &&
          event.target.closest('button, input, textarea, a, [role="button"]')
        )
          return;
        dragStart.current = event.clientX;
      },
      onMouseEnter: () => {
        if (sticky && suppressOpen.current) return;
        if (!expandedRef.current) closeArmed.current = false;
        expandedRef.current = true;
        setHovered(true);
      },
      onMouseLeave: () => {
        if (sticky) closeArmed.current = expandedRef.current;
        else {
          expandedRef.current = false;
          setHovered(false);
        }
      },
      onFocus: (e: FocusEvent) => setTyping(isTextInput(e.target)),
      onBlur: (e: FocusEvent) => setTyping(isTextInput(e.relatedTarget)),
    },
  };
}
