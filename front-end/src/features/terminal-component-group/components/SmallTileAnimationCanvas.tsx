/**
 * STATE MACHINE: SmallTileAnimationCanvas
 *
 * Canvas overlay for rendering small tile animations.
 *
 * ANIMATION LIFECYCLE:
 * [DISABLED] <-- enabled: false OR tileAnimationComplete: false
 *     |
 *     v (enabled + tileAnimationComplete)
 * [INITIALIZING] --> sets up canvases, calculates grid
 *     |
 *     v
 * [ANIMATING] --> requestAnimationFrame loop (useTileRenderLoop)
 *     |
 *     +--> animatingTiles: Set<TileKey> (from useSmallTileAnimations hook)
 *     +--> everColoredTiles: Set<TileKey> (all tiles that ever had color > 0)
 *     +--> renders dots, animations, borders on separate canvases
 *
 * Layer structure (bottom to top):
 * 1. Root container (z-[2]) - Animation canvases
 *    - Canvas: Dots (z-[-3]) - BELOW animations
 *    - Canvas: Animations (z-[-2]) - ABOVE dots
 *    - Canvas: Borders (z-[-1]) - ABOVE animations
 * 2. SVG tile borders/pattern (z-[3]) - Above animations
 * 3. Page content (z-[4]) - Above everything
 */

import { useEffect, useRef, type CSSProperties } from 'react';
import { useSmallTileAnimations } from '../hooks';
import { useViewportSize } from './smallTileAnimationCanvas/useViewportSize';
import { useScrollOffset } from './smallTileAnimationCanvas/useScrollOffset';
import { useCanvasSizing } from './smallTileAnimationCanvas/useCanvasSizing';
import { useTileRenderLoop } from './smallTileAnimationCanvas/useTileRenderLoop';

interface SmallTileAnimationCanvasProps {
  enabled: boolean;
  tileAnimationComplete: boolean;
  currentFrame: number;
  tileColors: Map<string, number>;
  selectedAgentId: string | null;
}

const TILE_SIZE = 143;
const LARGE_TILE_SIZE = 429;
const CANVAS_STYLE: CSSProperties = {
  width: '100%',
  height: '100%',
  imageRendering: 'pixelated',
};

export default function SmallTileAnimationCanvas({
  enabled,
  tileAnimationComplete,
  tileColors,
  selectedAgentId,
}: SmallTileAnimationCanvasProps) {
  const dotsCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationsCanvasRef = useRef<HTMLCanvasElement>(null);
  const bordersCanvasRef = useRef<HTMLCanvasElement>(null);

  const { width: viewportWidth, height: viewportHeight } = useViewportSize();
  const scrollOffset = useScrollOffset();

  const everColoredTiles = useRef<Set<string>>(new Set());
  useEffect(() => {
    tileColors.forEach((colorId, key) => {
      if (colorId > 0) everColoredTiles.current.add(key);
    });
  }, [tileColors]);

  const { animatingTiles, removeAnimatingTile } = useSmallTileAnimations({
    enabled: enabled && tileAnimationComplete,
    viewportWidth,
    viewportHeight,
    tileSize: TILE_SIZE,
    largeTileSize: LARGE_TILE_SIZE,
    everColoredTiles: everColoredTiles.current,
    animationInterval: 800,
    selectedAgentId,
    scrollOffset,
  });

  useCanvasSizing(dotsCanvasRef, animationsCanvasRef, bordersCanvasRef);

  useTileRenderLoop({
    enabled,
    dotsRef: dotsCanvasRef,
    animationsRef: animationsCanvasRef,
    bordersRef: bordersCanvasRef,
    viewportWidth,
    viewportHeight,
    scrollOffset,
    tileSize: TILE_SIZE,
    largeTileSize: LARGE_TILE_SIZE,
    animatingTiles,
    everColoredTiles: everColoredTiles.current,
    removeAnimatingTile,
  });

  return (
    <div className="pointer-events-none fixed inset-0 z-[2]">
      <canvas
        ref={dotsCanvasRef}
        className="pointer-events-none fixed inset-0 z-[-3]"
        style={CANVAS_STYLE}
      />
      <canvas
        ref={animationsCanvasRef}
        className="pointer-events-none fixed inset-0 z-[-2]"
        style={CANVAS_STYLE}
      />
      <canvas
        ref={bordersCanvasRef}
        className="pointer-events-none fixed inset-0 z-[-1]"
        style={CANVAS_STYLE}
      />
    </div>
  );
}
