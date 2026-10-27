/**
 * Anchors the non-modal settings dialog just above its trigger button, opening
 * away from the side of the screen the trigger lives on:
 *
 *   align 'end'   (stock TopBar gear, right end of the row): right edges align,
 *                 the panel extends leftward.
 *   align 'start' (Rose Desktop tab gear, left side of the query box): left
 *                 edges align, the panel extends rightward, shifted left only
 *                 as far as needed to stay inside the viewport.
 *
 * Recomputes before paint whenever `open` flips to true, reading the trigger's rect
 * and returning bottom/left/right values suitable for `position: fixed`.
 */

import { useLayoutEffect, useState, type RefObject } from 'react';
import type { ModalAlign, ModalPosition } from './types';

/** Panel width; the dialog also caps it at PANEL_MAX_WIDTH_VW of the viewport. */
export const PANEL_WIDTH_PX = 420;
export const PANEL_MAX_WIDTH_VW = 90;
const DEFAULT_POSITION: ModalPosition = { bottom: 80, left: 'auto', right: 16 };
const GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 8;

export function useModalPosition(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
  align: ModalAlign = 'end',
): ModalPosition {
  const [position, setPosition] = useState<ModalPosition>(DEFAULT_POSITION);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const bottom = window.innerHeight - rect.top + GAP_PX;
    if (align === 'end') {
      setPosition({ bottom, left: 'auto', right: window.innerWidth - rect.right });
      return;
    }
    const width = Math.min(PANEL_WIDTH_PX, (window.innerWidth * PANEL_MAX_WIDTH_VW) / 100);
    const maxLeft = window.innerWidth - width - VIEWPORT_MARGIN_PX;
    const left = Math.max(VIEWPORT_MARGIN_PX, Math.min(rect.left, maxLeft));
    setPosition({ bottom, left, right: 'auto' });
  }, [open, triggerRef, align]);

  return position;
}
