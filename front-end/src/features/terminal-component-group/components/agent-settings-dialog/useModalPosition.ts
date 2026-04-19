/**
 * Anchors the non-modal settings dialog above-and-right of its trigger button.
 *
 * Recomputes whenever `open` flips to true, reading the trigger's client rect
 * and returning a bottom/right offset in px suitable for `position: fixed`.
 */

import { useEffect, useState, type RefObject } from 'react';
import type { ModalPosition } from './types';

const DEFAULT_POSITION: ModalPosition = { bottom: 80, right: 16 };
const GAP_PX = 8;

export function useModalPosition(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
): ModalPosition {
  const [position, setPosition] = useState<ModalPosition>(DEFAULT_POSITION);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPosition({
      bottom: window.innerHeight - rect.top + GAP_PX,
      right: window.innerWidth - rect.right,
    });
  }, [open, triggerRef]);

  return position;
}
