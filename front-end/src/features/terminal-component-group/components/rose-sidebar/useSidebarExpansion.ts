/**
 * STATE MACHINE: useSidebarExpansion (Rose Desktop left bar open/width state)
 *
 *   [COLLAPSED] --pointer enters--> [HOVER-EXPANDED]
 *   [HOVER-EXPANDED] --pointer leaves (non-Mac)--> [COLLAPSED]
 *   [HOVER-EXPANDED] --Mac: pointer beyond width + 10% of the window--> [COLLAPSED]
 *   A right-click menu or a focused text input keeps it expanded.
 *
 *   any --primary-button pointerdown on the right-edge handle--> [DRAGGING]
 *     (the handle captures the pointer, so moves over iframes still arrive; width
 *     follows clientX, clamped to [236, min(560, 50% window)]; left of 150px
 *     previews COLLAPSED; body keeps col-resize + user-select:none). Other
 *     buttons (right-click) never start a drag.
 *   [DRAGGING] --end (pointerup | pointercancel | lostpointercapture | window blur),
 *     last position ≥150px (or no move)--> [PINNED at that width]
 *   [DRAGGING] --end, last position <150px--> [COLLAPSED] (unpinned)
 *   Arrow keys on the focused handle resize by 16px and pin.
 *   [PINNED] never auto-closes (pointer leave, right buffer, navigation);
 *   only Back (close) unpins it → [COLLAPSED].
 *
 * Width and pinned state persist in localStorage, so a pinned bar reopens
 * pinned at its width after a reload. The rendered width is re-clamped on
 * every window resize (the saved preference is kept for a wider window).
 *
 * CONTENT OFFSET (--rose-bar-offset on <html>, then ROSE_BAR_OFFSET_EVENT):
 *   [PINNED] or [DRAGGING open] → the bar's width: the chat is pushed right
 *   [COLLAPSED] / [HOVER-EXPANDED] / [DRAGGING toward the rail] → 64px (hover overlays)
 *   unmount → var removed
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import {
  ROSE_BAR_COLLAPSE_SNAP,
  ROSE_BAR_EXPANDED_WIDTH,
  ROSE_BAR_OFFSET_EVENT,
  ROSE_BAR_OFFSET_VAR,
  ROSE_BAR_PINNED_STORAGE_KEY,
  ROSE_BAR_WIDTH,
  ROSE_BAR_WIDTH_STORAGE_KEY,
  clampRoseBarWidth,
} from './roseSidebarLayout';

const KEY_STEP = 16;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A preference, not state we depend on.
  }
}

function readWidth(): number {
  const parsed = Number.parseInt(readStored(ROSE_BAR_WIDTH_STORAGE_KEY) ?? '', 10);
  return Number.isFinite(parsed) ? parsed : ROSE_BAR_EXPANDED_WIDTH;
}

/** Publish the content offset on <html> and tell fixed layers to re-measure. */
function usePublishedOffset(offset: number) {
  useLayoutEffect(() => {
    document.documentElement.style.setProperty(ROSE_BAR_OFFSET_VAR, `${offset}px`);
    window.dispatchEvent(new Event(ROSE_BAR_OFFSET_EVENT));
  }, [offset]);
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty(ROSE_BAR_OFFSET_VAR);
      window.dispatchEvent(new Event(ROSE_BAR_OFFSET_EVENT));
    },
    [],
  );
}

export function useSidebarExpansion() {
  const sticky =
    (window as typeof window & { api?: { isElectron?: boolean } }).api?.isElectron === true ||
    /^Mac/.test(navigator.platform);
  const suppressHover = useRef(false);
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  // The saved preference; the rendered width is it clamped to the live window.
  const [preferredWidth, setWidth] = useState(readWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const width = clampRoseBarWidth(preferredWidth, viewportWidth);
  const [pinned, setPinned] = useState(() => readStored(ROSE_BAR_PINNED_STORAGE_KEY) === 'true');
  const [drag, setDrag] = useState<{ collapsing: boolean } | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;
  const capture = useRef<{ handle: HTMLElement; pointerId: number } | null>(null);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const pin = useCallback((next: boolean) => {
    setPinned(next);
    writeStored(ROSE_BAR_PINNED_STORAGE_KEY, String(next));
  }, []);
  const close = useCallback(() => {
    suppressHover.current = true;
    setHovered(false);
    setMenuOpen(false);
    setTyping(false);
    pin(false);
  }, [pin]);
  useEffect(() => {
    if (!sticky || pinned || drag || !hovered || typing || menuOpen) return;
    const beyondRightBuffer = (event: MouseEvent) => {
      if (event.clientX > width + window.innerWidth * 0.1) {
        close();
        // Auto-close happens outside the drawer; the next entry is a fresh hover.
        suppressHover.current = false;
      }
    };
    window.addEventListener('mousemove', beyondRightBuffer);
    return () => window.removeEventListener('mousemove', beyondRightBuffer);
  }, [close, drag, hovered, menuOpen, pinned, sticky, typing, width]);
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    // The bar is anchored at left: 0, so the pointer's clientX IS the width.
    // Release acts on the last move, so a press without a move just pins.
    let collapsing = false;
    const onMove = (event: PointerEvent) => {
      collapsing = event.clientX < ROSE_BAR_COLLAPSE_SNAP;
      if (!collapsing) {
        widthRef.current = clampRoseBarWidth(event.clientX, window.innerWidth);
        setWidth(widthRef.current);
      }
      setDrag({ collapsing });
    };
    // Every end signal funnels here once: pointerup also releases the capture,
    // and a blur releases it explicitly, so lostpointercapture follows both.
    let ended = false;
    const onEnd = () => {
      if (ended) return;
      ended = true;
      const held = capture.current;
      capture.current = null;
      if (held?.handle.hasPointerCapture?.(held.pointerId)) {
        held.handle.releasePointerCapture(held.pointerId);
      }
      setDrag(null);
      if (collapsing) {
        close();
        return;
      }
      writeStored(ROSE_BAR_WIDTH_STORAGE_KEY, String(widthRef.current));
      pin(true);
    };
    const handle = capture.current?.handle ?? null;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', onEnd);
    handle?.addEventListener('lostpointercapture', onEnd);
    // Keep the resize cursor and stop text selection for the whole drag.
    const { cursor: previousCursor, userSelect: previousUserSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onEnd);
      handle?.removeEventListener('lostpointercapture', onEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [close, dragging, pin]);
  const isTextInput = (el: EventTarget | null) => el instanceof HTMLInputElement;
  const open = pinned || hovered || menuOpen || typing;
  const pushesContent = drag ? !drag.collapsing : pinned;
  usePublishedOffset(pushesContent ? width : ROSE_BAR_WIDTH);
  return {
    sticky,
    isExpanded: drag ? !drag.collapsing : open,
    isPinned: pinned,
    isDragging: dragging,
    width,
    minWidth: ROSE_BAR_EXPANDED_WIDTH,
    maxWidth: clampRoseBarWidth(Number.POSITIVE_INFINITY, viewportWidth),
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
    resizeHandle: {
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        const handle = event.currentTarget;
        handle.setPointerCapture?.(event.pointerId);
        capture.current = { handle, pointerId: event.pointerId };
        setDrag({ collapsing: false });
      },
      onKeyDown: (event: KeyboardEvent) => {
        const delta =
          event.key === 'ArrowRight' ? KEY_STEP : event.key === 'ArrowLeft' ? -KEY_STEP : 0;
        if (delta === 0) return;
        event.preventDefault();
        const next = clampRoseBarWidth(widthRef.current + delta, window.innerWidth);
        widthRef.current = next;
        setWidth(next);
        writeStored(ROSE_BAR_WIDTH_STORAGE_KEY, String(next));
        pin(true);
      },
    },
  };
}
