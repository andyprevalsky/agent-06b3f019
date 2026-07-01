import { useEffect, useRef, type RefObject } from 'react';
import type { AnimatingTile } from '@/lib/smallTileAnimations';
import { computeGridOrigin, drawAnimations, drawDots } from './renderTiles';

interface ScrollOffset {
  x: number;
  y: number;
}

interface Args {
  enabled: boolean;
  dotsRef: RefObject<HTMLCanvasElement>;
  animationsRef: RefObject<HTMLCanvasElement>;
  bordersRef: RefObject<HTMLCanvasElement>;
  viewportWidth: number;
  viewportHeight: number;
  scrollOffset: ScrollOffset;
  tileSize: number;
  largeTileSize: number;
  animatingTiles: AnimatingTile[];
  everColoredTiles: Set<string>;
  removeAnimatingTile: (tile: AnimatingTile) => void;
}

function clearCanvases(...contexts: CanvasRenderingContext2D[]) {
  contexts.forEach((ctx) => {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  });
}

export function useTileRenderLoop({
  enabled,
  dotsRef,
  animationsRef,
  bordersRef,
  viewportWidth,
  viewportHeight,
  scrollOffset,
  tileSize,
  largeTileSize,
  animatingTiles,
  everColoredTiles,
  removeAnimatingTile,
}: Args) {
  const animationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    const dotsCtx = dotsRef.current?.getContext('2d');
    const animationsCtx = animationsRef.current?.getContext('2d');
    const bordersCtx = bordersRef.current?.getContext('2d');
    if (!dotsCtx || !animationsCtx || !bordersCtx) return;

    if (!enabled) {
      clearCanvases(dotsCtx, animationsCtx, bordersCtx);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    const animatingPositions = new Set(
      animatingTiles.map((tile) => `${tile.position.row},${tile.position.col}`),
    );
    const origin = computeGridOrigin({
      viewportWidth,
      viewportHeight,
      tileSize,
      largeTileSize,
      scrollOffset,
    });

    clearCanvases(dotsCtx, animationsCtx, bordersCtx);
    drawDots(dotsCtx, origin, tileSize, everColoredTiles, animatingPositions);

    if (animatingTiles.length === 0) {
      return;
    }

    const render = () => {
      animationsCtx.clearRect(0, 0, animationsCtx.canvas.width, animationsCtx.canvas.height);
      const completed = drawAnimations(
        animationsCtx,
        origin,
        tileSize,
        animatingTiles,
        performance.now(),
      );
      if (completed.length > 0) completed.forEach((tile) => removeAnimatingTile(tile));
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
    dotsRef,
    animationsRef,
    bordersRef,
    animatingTiles,
    viewportWidth,
    viewportHeight,
    scrollOffset,
    tileSize,
    largeTileSize,
    everColoredTiles,
    removeAnimatingTile,
  ]);
}
