/**
 * STATE MACHINE: Top-right global controls
 *
 * [MOUNTED] --> reserves the inspection slot to the left of global controls
 * [NO INSPECTION] --> empty slot contributes no layout width
 * [INSPECTING] --> compact inspection pill + admin account pill share one rail
 * [NARROW VIEWPORT] --> inspection label truncates; controls stay on one row
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
 * Horizontal offset (md+): the rail sits left of the right app bar and any open
 * app drawer (--rose-apps-inset), so it never covers their icons or close X.
 */

import type { ReactNode } from 'react';

export const TOP_RIGHT_INSPECTION_SLOT_ID = 'top-right-inspection-slot';

interface TopRightControlsProps {
  children: ReactNode;
}

export function TopRightControls({ children }: TopRightControlsProps) {
  return (
    <div
      className="fixed right-4 md:right-[calc(var(--rose-apps-inset,0px)+1rem)] top-[calc(var(--mobile-terminal-header-height)+0.5rem)] z-[100] flex max-w-[calc(100vw-2rem)] items-start justify-end gap-2 md:top-9"
      data-testid="top-right-controls"
    >
      <div className="contents" id={TOP_RIGHT_INSPECTION_SLOT_ID} />
      {children}
    </div>
  );
}
