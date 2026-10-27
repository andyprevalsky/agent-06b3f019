/**
 * Anchors the non-modal settings dialog just above its trigger button, opening
 * away from the side of the screen the trigger lives on, always inside the
 * viewport:
 *
 *   align 'end'   (stock TopBar gear, right end of the row): right edges align,
 *                 the panel extends leftward.
 *   align 'start' (Rose Desktop tab gear, left side of the query box): left
 *                 edges align, the panel extends rightward.
 *
 * Either edge is clamped to an 8px viewport gutter and the width is capped to
 * the viewport, so a phone never shows the panel hanging off a side. The height
 * is capped to the room between the trigger and the safe-area-aware mobile
 * header (an installed iPhone PWA draws the status bar over the page).
 *
 * Recomputes before paint whenever `open` flips to true and on every window
 * resize while open (phone rotation), reading the trigger's client rect.
 */

import { useLayoutEffect, useState, type RefObject } from 'react';
import type { ModalAlign, ModalPosition } from './types';

export const PANEL_WIDTH_PX = 420;
/** Gap between the panel and the trigger, and between the panel and screen edges. */
const GAP_PX = 8;

const DEFAULT_POSITION: ModalPosition = {
  bottom: 80,
  left: 'auto',
  right: 16,
  width: PANEL_WIDTH_PX,
  maxHeight: '85vh',
};

export function computeModalPosition(
  trigger: Pick<DOMRect, 'top' | 'left' | 'right'>,
  viewport: { width: number; height: number },
  align: ModalAlign = 'end',
): ModalPosition {
  const width = Math.min(PANEL_WIDTH_PX, viewport.width - 2 * GAP_PX);
  const maxOffset = viewport.width - width - GAP_PX;
  const clamp = (offset: number) => Math.min(Math.max(offset, GAP_PX), maxOffset);
  const bottom = viewport.height - trigger.top + GAP_PX;
  const maxHeight = `min(85vh, calc(${viewport.height - bottom - GAP_PX}px - var(--mobile-terminal-header-height)))`;
  return align === 'end'
    ? { bottom, left: 'auto', right: clamp(viewport.width - trigger.right), width, maxHeight }
    : { bottom, left: clamp(trigger.left), right: 'auto', width, maxHeight };
}

export function useModalPosition(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
  align: ModalAlign = 'end',
): ModalPosition {
  const [position, setPosition] = useState<ModalPosition>(DEFAULT_POSITION);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const fit = () => {
      if (!triggerRef.current) return;
      setPosition(
        computeModalPosition(
          triggerRef.current.getBoundingClientRect(),
          { width: window.innerWidth, height: window.innerHeight },
          align,
        ),
      );
    };
    fit();
    // Rotation / window resize while open: re-fit from the moved trigger.
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open, triggerRef, align]);

  return position;
}
