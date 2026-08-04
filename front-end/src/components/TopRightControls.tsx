/**
 * STATE MACHINE: Top-right global controls
 *
 * [MOUNTED] --> reserves the inspection slot to the left of global controls
 * [NO INSPECTION] --> empty slot contributes no layout width
 * [INSPECTING] --> compact inspection pill + admin account pill share one rail
 * [NARROW VIEWPORT] --> inspection label truncates; controls stay on one row
 *
 * Nudged down (top-9 vs top-4) so the rail clears the close (X) buttons on the
 * browser/agent screens and the mobile main page it would otherwise sit on top of.
 */

import type { ReactNode } from 'react';

export const TOP_RIGHT_INSPECTION_SLOT_ID = 'top-right-inspection-slot';

interface TopRightControlsProps {
  children: ReactNode;
}

export function TopRightControls({ children }: TopRightControlsProps) {
  return (
    <div
      className="fixed right-4 top-9 z-[100] flex max-w-[calc(100vw-2rem)] items-start justify-end gap-2"
      data-testid="top-right-controls"
    >
      <div className="contents" id={TOP_RIGHT_INSPECTION_SLOT_ID} />
      {children}
    </div>
  );
}
