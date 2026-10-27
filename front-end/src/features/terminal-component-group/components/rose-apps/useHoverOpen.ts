/** Deliberate mouse hover opens panels; touch and theme controls keep click behavior. */
import { useEffect, useRef, type PointerEvent } from 'react';

export const APP_HOVER_DELAY_MS = 250;
export function useHoverOpen(open?: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(open);
  latest.current = open;
  const cancel = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  return {
    cancel,
    enter: (event: PointerEvent) => {
      cancel();
      if (event.pointerType !== 'mouse' || !latest.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        latest.current?.();
      }, APP_HOVER_DELAY_MS);
    },
  };
}
