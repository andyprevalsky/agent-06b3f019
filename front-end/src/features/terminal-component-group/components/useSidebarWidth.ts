/**
 * STATE MACHINE: useSidebarWidth
 *
 * [IDLE] --pointerdown on handle--> [DRAGGING] --pointermove--> [DRAGGING]
 *   ^                                    |
 *   +-------- pointerup / pointercancel -+   (width persisted to localStorage)
 *
 * WIDTH DOMAIN (px):
 *   COLLAPSED(64) <--snap-- [ <160 ] --drag--> [ 220 .. 480 ] clamped
 *
 * Replaces the old one-click chevron toggle: the rail is now sized by dragging
 * its right edge, and dragging it very narrow snaps to the collapsed icon rail.
 * The chosen width survives reloads via localStorage.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  SIDEBAR_COLLAPSE_SNAP_WIDTH,
  SIDEBAR_WIDTH_COLLAPSED,
  SIDEBAR_WIDTH_EXPANDED,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from '../config';

/** Snap to the rail below the snap point, otherwise clamp into [MIN, MAX]. */
export function resolveSidebarWidth(rawWidth: number): number {
  if (rawWidth < SIDEBAR_COLLAPSE_SNAP_WIDTH) return SIDEBAR_WIDTH_COLLAPSED;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, rawWidth));
}

function readStoredWidth(): number {
  try {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (stored === null) return SIDEBAR_WIDTH_EXPANDED;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? resolveSidebarWidth(parsed) : SIDEBAR_WIDTH_EXPANDED;
  } catch {
    // Private-mode / disabled storage — fall back to the default width.
    return SIDEBAR_WIDTH_EXPANDED;
  }
}

function persistWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Width is a preference, not state we depend on — losing it is acceptable.
  }
}

export interface SidebarWidthController {
  width: number;
  isCollapsed: boolean;
  isDragging: boolean;
  /** Attach to the drag handle's onPointerDown. */
  startDrag: (event: React.PointerEvent) => void;
  /** Programmatic set (e.g. admin-health collapses the rail). */
  setWidth: (width: number) => void;
}

export function useSidebarWidth(): SidebarWidthController {
  const [width, setWidthState] = useState<number>(readStoredWidth);
  const [isDragging, setIsDragging] = useState(false);
  // Kept in a ref so the pointerup listener persists the final width without
  // re-subscribing on every pointermove.
  const widthRef = useRef(width);

  const setWidth = useCallback((next: number) => {
    const resolved = resolveSidebarWidth(next);
    widthRef.current = resolved;
    setWidthState(resolved);
    persistWidth(resolved);
  }, []);

  const startDrag = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    // The sidebar is anchored at left: 0, so the pointer's clientX IS the width.
    const handleMove = (event: PointerEvent) => {
      const resolved = resolveSidebarWidth(event.clientX);
      widthRef.current = resolved;
      setWidthState(resolved);
    };
    const handleUp = () => {
      setIsDragging(false);
      persistWidth(widthRef.current);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    // Stop the drag from selecting page text under the cursor.
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      document.body.style.userSelect = previousUserSelect;
    };
  }, [isDragging]);

  return {
    width,
    isCollapsed: width <= SIDEBAR_WIDTH_COLLAPSED,
    isDragging,
    startDrag,
    setWidth,
  };
}
