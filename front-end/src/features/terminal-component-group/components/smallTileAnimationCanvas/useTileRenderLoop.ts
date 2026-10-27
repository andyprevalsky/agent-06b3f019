import { useEffect, useLayoutEffect, useRef, type MutableRefObject, type RefObject } from 'react';
import type { AnimatingTile } from '@/lib/smallTileAnimations';
import { computeGridOrigin, drawAnimations, drawDots } from './renderTiles';

interface ScrollOffset {
  x: number;
  y: number;
}

interface Args {
  enabled: boolean;
  /** Rose dark mode: draw nothing; un-hiding repaints the dots in that same commit. */
  hidden?: boolean;
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

function cancelFrame(frameRef: MutableRefObject<number | null>) {
  if (frameRef.current) {
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }
}

/** Repaints only the dot canvas (the theme-switch path; see useRepaintDotsWhenShown). */
function repaintDots(...args: Parameters<typeof drawDots>) {
  clearCanvases(args[0]);
  drawDots(...args);
}

/**
 * Theme switch: un-hiding paints the dots now, in the commit that removed
 * html.dark (layout phase, after the class flipped), never on a later tick.
 */
function useRepaintDotsWhenShown(
  hidden: boolean | undefined,
  repaintDotsRef: MutableRefObject<(() => void) | null>,
) {
  const wasHiddenRef = useRef(hidden === true);
  useLayoutEffect(() => {
    const isHidden = hidden === true;
    if (wasHiddenRef.current === isHidden) return;
    wasHiddenRef.current = isHidden;
    if (!isHidden) repaintDotsRef.current?.();
  }, [hidden, repaintDotsRef]);
}

export function useTileRenderLoop({
  enabled,
  hidden,
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
  const repaintDotsRef = useRef<(() => void) | null>(null);
  useRepaintDotsWhenShown(hidden, repaintDotsRef);

  useEffect(() => {
    const dotsCtx = dotsRef.current?.getContext('2d');
    const animationsCtx = animationsRef.current?.getContext('2d');
    const bordersCtx = bordersRef.current?.getContext('2d');
    if (!dotsCtx || !animationsCtx || !bordersCtx) return;

    if (!enabled) {
      repaintDotsRef.current = null;
      clearCanvases(dotsCtx, animationsCtx, bordersCtx);
      cancelFrame(animationFrameRef);
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

    repaintDotsRef.current = () =>
      repaintDots(dotsCtx, origin, tileSize, everColoredTiles, animatingPositions);

    clearCanvases(dotsCtx, animationsCtx, bordersCtx);
    // Rose dark mode: no dots and no animations are drawn at all.
    if (hidden === true) return;
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
    return () => cancelFrame(animationFrameRef);
  }, [
    enabled,
    hidden,
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
