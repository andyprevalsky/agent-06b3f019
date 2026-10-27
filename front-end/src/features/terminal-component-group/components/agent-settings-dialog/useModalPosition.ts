/**
 * Anchors the non-modal settings dialog above-and-right of its trigger button,
 * kept inside the viewport.
 *
 * Recomputes whenever `open` flips to true and on every window resize while
 * open (phone rotation), reading the trigger's client rect.
 * The panel's right edge follows the trigger's but is clamped so the whole
 * panel stays on screen (on a phone the query-box gear sits mid-screen, and a
 * right-anchored 420px panel would hang off the left edge). Its height is
 * capped to the room between the trigger and the safe-area-aware mobile header.
 */

import { useEffect, useState, type RefObject } from 'react';
import type { ModalPosition } from './types';

export const PANEL_WIDTH_PX = 420;
/** Gap between the panel and the trigger, and between the panel and screen edges. */
const GAP_PX = 8;

export function computeModalPosition(
  trigger: Pick<DOMRect, 'top' | 'right'>,
  viewport: { width: number; height: number },
): ModalPosition {
  const width = Math.min(PANEL_WIDTH_PX, viewport.width - 2 * GAP_PX);
  const maxRight = viewport.width - width - GAP_PX;
  const right = Math.min(Math.max(viewport.width - trigger.right, GAP_PX), maxRight);
  const bottom = viewport.height - trigger.top + GAP_PX;
  return {
    bottom,
    right,
    width,
    maxHeight: `min(85vh, calc(${viewport.height - bottom - GAP_PX}px - var(--mobile-terminal-header-height)))`,
  };
}

const DEFAULT_POSITION: ModalPosition = {
  bottom: 80,
  right: 16,
  width: PANEL_WIDTH_PX,
  maxHeight: '85vh',
};

export function useModalPosition(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
): ModalPosition {
  const [position, setPosition] = useState<ModalPosition>(DEFAULT_POSITION);

  useEffect(() => {
    if (!open) return undefined;
    const fit = () => {
      if (!triggerRef.current) return;
      setPosition(
        computeModalPosition(triggerRef.current.getBoundingClientRect(), {
          width: window.innerWidth,
          height: window.innerHeight,
        }),
      );
    };
    fit();
    // Rotation / window resize while open: re-fit from the moved trigger.
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open, triggerRef]);

  return position;
}
