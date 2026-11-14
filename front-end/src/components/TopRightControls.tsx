/**
 * STATE MACHINE: Top-right global controls
 *
 * [MOUNTED] --> reserves the inspection slot to the left of global controls
 * [NO INSPECTION] --> empty slot contributes no layout width
 * [INSPECTING] --> compact inspection pill + admin account pill share one rail
 * [NARROW VIEWPORT] --> inspection label truncates; controls stay on one row
 *
 * [PHONE FULLSCREEN] -> same rail host moves into its reserved header slot.
 * [CLOSE] -> restore normal placement and focus without remounting children.
 *
 * Vertical offset is breakpoint-aware:
 *   - Desktop (md+): the terminal header is a CENTERED floating pill, so this
 *     top-right rail never overlaps it. top-9 just clears the close (X) buttons
 *     on the browser/agent screens it would otherwise sit on top of.
 *   - Mobile (< md): the header is a FULL-WIDTH bar with the hamburger menu at
 *     the exact top-right corner. Sitting at top-9 (36px) still lands inside the
 *     3.5rem header and covers that button, so drop the rail just below the
 *     header (its full height incl. safe-area inset) to clear the menu entirely.
 *
 * Horizontal offset (md+): with Rose Desktop the rail sits left of the bare
 * top-right app icons (--rose-app-icons-inset, published by RoseAppsProvider),
 * so it never covers them; the stock UI publishes nothing (offset 0).
 */

import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useGlobalControlsLayout } from './globalControlsLayoutContext';

export const TOP_RIGHT_INSPECTION_SLOT_ID = 'top-right-inspection-slot';

interface TopRightControlsProps {
  children: ReactNode;
}

export function TopRightControls({ children }: TopRightControlsProps) {
  const { slot } = useGlobalControlsLayout();
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'min-w-0 max-w-full';
    return element;
  });
  useLayoutEffect(() => {
    const focused = document.activeElement;
    if (slot) slot.appendChild(host);
    else document.body.insertBefore(host, document.body.firstChild);
    if (focused instanceof HTMLElement && host.contains(focused)) focused.focus();
  }, [host, slot]);
  useLayoutEffect(() => () => host.remove(), [host]);
  return createPortal(
    <div
      className={
        slot
          ? 'flex min-w-0 max-w-full items-start justify-end gap-2'
          : 'fixed right-4 md:right-[calc(var(--rose-app-icons-inset,0px)+1rem)] top-[calc(var(--mobile-terminal-header-height)+0.5rem)] z-[100] flex max-w-[calc(100vw-2rem)] items-start justify-end gap-2 md:top-9'
      }
      data-testid="top-right-controls"
    >
      <div className="contents" id={TOP_RIGHT_INSPECTION_SLOT_ID} />
      {children}
    </div>,
    host,
  );
}
