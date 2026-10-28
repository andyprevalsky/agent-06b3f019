/**
 * Visual shell for the launcher pill: liquid-metal ring + inset fill + optional drag overlay.
 * Colors come from the launcher palette vars (config.ts LAUNCHER_GLOBAL_CSS), which
 * switch under html.dark.
 */

import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import { LiquidMetalRing, LIQUID_METAL_RING_PX } from '../../../shared/liquid-metal';
import { LAUNCHER_PILL_HEIGHT, LAUNCHER_PILL_WIDTH } from '../config';

/** Idle pill is 52px tall → ends are radius 26. Keep that on every height. */
const OUTER_RADIUS = LAUNCHER_PILL_HEIGHT / 2;
const INNER_RADIUS = OUTER_RADIUS - LIQUID_METAL_RING_PX;

interface LauncherShellProps {
  pillHeight: number;
  isDragOver: boolean;
  dragHandlers: {
    onDragOver: (e: ReactDragEvent) => void;
    onDragLeave: (e: ReactDragEvent) => void;
    onDrop: (e: ReactDragEvent) => void;
  };
  children: ReactNode;
}

function DragOverlay(): React.JSX.Element {
  return (
    <div
      data-testid="launcher-drag-overlay"
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: INNER_RADIUS,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--launcher-drop-bg)',
        color: 'var(--launcher-drop-text)',
        fontSize: 13,
        fontWeight: 600,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      Drop files here
    </div>
  );
}

const LauncherShell = ({
  pillHeight,
  isDragOver,
  dragHandlers,
  children,
}: LauncherShellProps): React.JSX.Element => (
  <div
    className="drag-region"
    style={{
      position: 'absolute',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      width: LAUNCHER_PILL_WIDTH,
      height: pillHeight,
      borderRadius: OUTER_RADIUS,
      boxShadow: 'var(--launcher-shadow)',
    }}
  >
    <LiquidMetalRing radius={OUTER_RADIUS} />
    <div
      className="no-drag"
      data-testid="launcher-drop-target"
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
      style={{
        position: 'absolute',
        inset: LIQUID_METAL_RING_PX,
        borderRadius: INNER_RADIUS,
        backgroundColor: 'var(--launcher-fill)',
        boxShadow: 'var(--launcher-fill-shadow)',
        color: 'var(--launcher-text)',
        display: 'flex',
        alignItems: 'stretch',
      }}
    >
      {children}
      {isDragOver ? <DragOverlay /> : null}
    </div>
  </div>
);

export default LauncherShell;
