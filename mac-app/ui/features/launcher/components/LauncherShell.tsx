/**
 * Visual shell for the launcher pill: metal ring + inset fill + optional drag overlay.
 */

import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import ShaderTile from './ShaderTile';
import { LAUNCHER_PILL_HEIGHT, LAUNCHER_PILL_WIDTH } from '../config';

/** Same mask ShaderTile applies — CSS twin so the ring still shows if WebGL is unavailable. */
const SHADER_MASK =
  'linear-gradient(to right, rgba(0,0,0,1) 0%, rgba(0,0,0,0.3) 50%, rgba(0,0,0,0) 100%)';

/** Idle pill is 52px tall → ends are radius 26. Keep that on every height. */
const OUTER_RADIUS = LAUNCHER_PILL_HEIGHT / 2;
const INNER_RADIUS = OUTER_RADIUS - 2;

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

function LauncherRing({ pillHeight }: { pillHeight: number }): React.JSX.Element {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        borderRadius: OUTER_RADIUS,
        overflow: 'hidden',
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(115deg, #FE7503 0%, #FC585C 28%, #E062CC 58%, #7A6BEC 100%)',
          maskImage: SHADER_MASK,
          WebkitMaskImage: SHADER_MASK,
        }}
      />
      <ShaderTile size={pillHeight} />
    </div>
  );
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
        background: 'rgba(245, 245, 245, 0.92)',
        color: '#1d4ed8',
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
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15), 0 2px 4px rgba(0, 0, 0, 0.1)',
    }}
  >
    <LauncherRing pillHeight={pillHeight} />
    <div
      className="no-drag"
      data-testid="launcher-drop-target"
      onDragOver={dragHandlers.onDragOver}
      onDragLeave={dragHandlers.onDragLeave}
      onDrop={dragHandlers.onDrop}
      style={{
        position: 'absolute',
        top: 2,
        left: 2,
        right: 2,
        bottom: 2,
        borderRadius: INNER_RADIUS,
        backgroundColor: '#f5f5f5',
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
