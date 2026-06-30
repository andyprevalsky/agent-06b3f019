/**
 * Blackbox tests for tile animation scheduling.
 *
 * Proves the decorative canvas keeps static tile markers visible without
 * running a continuous requestAnimationFrame loop when no tile is animating.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTileRenderLoop } from '@/features/terminal-component-group/components/smallTileAnimationCanvas/useTileRenderLoop';

function canvasRef() {
  const ctx = {
    canvas: { width: 390, height: 844 },
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: '',
  };
  return {
    ref: {
      current: {
        getContext: () => ctx,
      },
    },
    ctx,
  };
}

describe('tile animation canvas scheduling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not start a frame loop when only static dots need rendering', () => {
    const requestAnimationFrame = vi.fn(() => 1);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestAnimationFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

    const dots = canvasRef();
    const animations = canvasRef();
    const borders = canvasRef();

    renderHook(() =>
      useTileRenderLoop({
        enabled: true,
        dotsRef: dots.ref as never,
        animationsRef: animations.ref as never,
        bordersRef: borders.ref as never,
        viewportWidth: 390,
        viewportHeight: 844,
        scrollOffset: { x: 0, y: 0 },
        tileSize: 143,
        largeTileSize: 429,
        animatingTiles: [],
        everColoredTiles: new Set(['0,0']),
        removeAnimatingTile: vi.fn(),
      }),
    );

    expect(dots.ctx.clearRect).toHaveBeenCalledTimes(1);
    expect(dots.ctx.arc).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});
