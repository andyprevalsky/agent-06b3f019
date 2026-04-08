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
 * [ANIMATING] --> requestAnimationFrame loop
 *     |
 *     +--> animatingTiles: Set<TileKey> (from useSmallTileAnimations hook)
 *     +--> everAnimatedTiles: Set<TileKey> (all tiles that ever animated)
 *     +--> renders dots, animations, borders on separate canvases
 *
 * Layer structure (bottom to top):
 * 1. Root container (z-[2]) - Animation canvases
 *    - Canvas: Dots (z-[-3]) - BELOW animations
 *    - Canvas: Animations (z-[-2]) - ABOVE dots
 *    - Canvas: Borders (z-[-1]) - ABOVE animations
 * 2. SVG tile borders/pattern (z-[3]) - Above animations
 * 3. Page content (z-[4]) - Above everything
 *
 * States:
 * - everAnimatedTiles: Set<string> (persisted across animation cycles)
 * - Animation state managed by useSmallTileAnimations hook
 */

import { useEffect, useRef, useState } from 'react';
import { useSmallTileAnimations } from '@/hooks/useSmallTileAnimations';
import { drawDotMarker, AnimatingTile, TileGridPosition } from '@/lib/smallTileAnimations';
import { renderProceduralAnimationSync } from '@/lib/proceduralTileAnimation';

interface SmallTileAnimationCanvasProps {
  enabled: boolean;
  tileAnimationComplete: boolean; // Only start after initial color animation
  currentFrame: number; // Current frame of the color animation
  tileColors: Map<string, number>; // Tile colors from the animation
  selectedAgentId: string | null; // Whether an agent is selected (affects refill behavior)
}

export default function SmallTileAnimationCanvas({
  enabled,
  tileAnimationComplete,
  currentFrame,
  tileColors,
  selectedAgentId,
}: SmallTileAnimationCanvasProps) {
  const dotsCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationsCanvasRef = useRef<HTMLCanvasElement>(null);
  const bordersCanvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);

  // Make viewport dimensions reactive
  const [viewportWidth, setViewportWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 0,
  );
  const [viewportHeight, setViewportHeight] = useState(
    typeof window !== 'undefined' ? window.innerHeight : 0,
  );
  const [scrollOffset, setScrollOffset] = useState({ x: 0, y: 0 });
  const tileSize = 143;
  const largeTileSize = 429;

  // Track tiles that have EVER had a color > 0
  const everColoredTiles = useRef<Set<string>>(new Set());

  // Update the set whenever tileColors changes
  useEffect(() => {
    tileColors.forEach((colorId, key) => {
      if (colorId > 0) {
        everColoredTiles.current.add(key);
      }
    });
  }, [tileColors]);

  const { animatingTiles, removeAnimatingTile } = useSmallTileAnimations({
    enabled: enabled && tileAnimationComplete,
    viewportWidth,
    viewportHeight,
    tileSize,
    largeTileSize,
    everColoredTiles: everColoredTiles.current,
    animationInterval: 800, // Trigger new animation every 0.8 seconds
    selectedAgentId, // Don't refill if agent is selected
    scrollOffset, // Pass scroll offset for position calculations
  });

  // Set canvas sizes to match viewport and update viewport dimensions
  useEffect(() => {
    const dotsCanvas = dotsCanvasRef.current;
    const animationsCanvas = animationsCanvasRef.current;
    const bordersCanvas = bordersCanvasRef.current;
    if (!dotsCanvas || !animationsCanvas || !bordersCanvas) return;

    const updateSize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;

      // Update viewport dimensions state
      setViewportWidth(width);
      setViewportHeight(height);

      // Set canvas sizes (actual pixel dimensions, not CSS)
      // Using 1:1 pixel ratio for crisp rendering
      dotsCanvas.width = width;
      dotsCanvas.height = height;
      animationsCanvas.width = width;
      animationsCanvas.height = height;
      bordersCanvas.width = width;
      bordersCanvas.height = height;

      // Disable image smoothing on all canvas contexts for pixel-perfect rendering
      const dotsCtx = dotsCanvas.getContext('2d');
      const animationsCtx = animationsCanvas.getContext('2d');
      const bordersCtx = bordersCanvas.getContext('2d');

      if (dotsCtx) {
        dotsCtx.imageSmoothingEnabled = false;
      }
      if (animationsCtx) {
        animationsCtx.imageSmoothingEnabled = false;
      }
      if (bordersCtx) {
        bordersCtx.imageSmoothingEnabled = false;
      }
    };

    updateSize();
    window.addEventListener('resize', updateSize);

    return () => {
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  // Track scroll position
  useEffect(() => {
    const handleScroll = () => {
      setScrollOffset({
        x: window.scrollX,
        y: window.scrollY,
      });
    };

    handleScroll(); // Initial value
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
    };
  }, []);

  // Render loop
  useEffect(() => {
    const dotsCanvas = dotsCanvasRef.current;
    const animationsCanvas = animationsCanvasRef.current;
    const bordersCanvas = bordersCanvasRef.current;
    if (!dotsCanvas || !animationsCanvas || !bordersCanvas) return;

    const dotsCtx = dotsCanvas.getContext('2d');
    const animationsCtx = animationsCanvas.getContext('2d');
    const bordersCtx = bordersCanvas.getContext('2d');
    if (!dotsCtx || !animationsCtx || !bordersCtx) return;

    if (!enabled) {
      // Clear all canvases if disabled
      dotsCtx.clearRect(0, 0, dotsCanvas.width, dotsCanvas.height);
      animationsCtx.clearRect(0, 0, animationsCanvas.width, animationsCanvas.height);
      bordersCtx.clearRect(0, 0, bordersCanvas.width, bordersCanvas.height);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    const render = () => {
      // Clear all canvases
      dotsCtx.clearRect(0, 0, dotsCanvas.width, dotsCanvas.height);
      animationsCtx.clearRect(0, 0, animationsCanvas.width, animationsCanvas.height);
      bordersCtx.clearRect(0, 0, bordersCanvas.width, bordersCanvas.height);

      // Get currently animating tile positions
      const animatingPositions = new Set(
        animatingTiles.map((tile) => `${tile.position.row},${tile.position.col}`),
      );

      // Calculate grid origin (accounting for scroll)
      const centerX = viewportWidth / 2;
      const centerY = viewportHeight * 0.4;
      const largeTileHalf = largeTileSize / 2;
      const tilesLeft = Math.floor((centerX - largeTileHalf) / tileSize);
      const tilesUp = Math.floor((centerY - largeTileHalf) / tileSize);
      const gridOriginX = centerX - largeTileHalf - tilesLeft * tileSize + scrollOffset.x;
      const gridOriginY = centerY - largeTileHalf - tilesUp * tileSize + scrollOffset.y;

      // Draw dots on DOTS canvas for tiles that have EVER had colors > 0
      // Use theme-appropriate color to match tile borders
      const isDarkMode = document.documentElement.classList.contains('dark');
      const dotColor = isDarkMode ? 'rgba(31, 41, 55, 0.8)' : 'rgba(229, 231, 235, 0.8)';

      everColoredTiles.current.forEach((key) => {
        if (!animatingPositions.has(key)) {
          const [row, col] = key.split(',').map(Number);
          const x = gridOriginX + col * tileSize;
          const y = gridOriginY + row * tileSize;
          drawDotMarker(dotsCtx, x, y, tileSize, dotColor);
        }
      });

      // Render animations on ANIMATIONS canvas
      const now = performance.now();
      const completedTiles: AnimatingTile[] = [];

      animatingTiles.forEach((tile) => {
        const elapsedMs = now - tile.startTime;

        // Recalculate screen position from row/col using current grid origin
        // This ensures animations move smoothly with the grid when viewport resizes
        const screenX = gridOriginX + tile.position.col * tileSize;
        const screenY = gridOriginY + tile.position.row * tileSize;

        const isStillPlaying = renderProceduralAnimationSync(
          animationsCtx,
          screenX,
          screenY,
          tileSize,
          elapsedMs,
          tile.animationId, // Pass the animation ID to render the correct animation
        );

        // If animation is complete, mark for removal
        if (!isStillPlaying) {
          completedTiles.push(tile);
        }
      });

      // Remove completed animations
      if (completedTiles.length > 0) {
        completedTiles.forEach((tile) => removeAnimatingTile(tile));
      }

      animationFrameRef.current = requestAnimationFrame(render);
    };

    animationFrameRef.current = requestAnimationFrame(render);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [
    enabled,
    tileAnimationComplete,
    tileColors,
    animatingTiles,
    tileSize,
    viewportWidth,
    viewportHeight,
    largeTileSize,
    scrollOffset,
  ]);

  return (
    <div className="pointer-events-none fixed inset-0 z-[2]">
      {/* Dots canvas - Bottom layer (z-[-3]) */}
      <canvas
        ref={dotsCanvasRef}
        className="pointer-events-none fixed inset-0 z-[-3]"
        style={{
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated' as any, // CSS for crisp pixel rendering (fallbacks handled by browser)
        }}
      />

      {/* Animations canvas - Middle layer (z-[-2]) */}
      <canvas
        ref={animationsCanvasRef}
        className="pointer-events-none fixed inset-0 z-[-2]"
        style={{
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated' as any, // CSS for crisp pixel rendering (fallbacks handled by browser)
        }}
      />

      {/* Borders canvas - Top layer (z-[-1]) */}
      <canvas
        ref={bordersCanvasRef}
        className="pointer-events-none fixed inset-0 z-[-1]"
        style={{
          width: '100%',
          height: '100%',
          imageRendering: 'pixelated' as any, // CSS for crisp pixel rendering (fallbacks handled by browser)
        }}
      />
    </div>
  );
}
