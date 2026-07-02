/**
 * Blackbox tests for tile animation scheduling.
 *
 * Proves the decorative canvas keeps static tile markers visible without
 * running a continuous requestAnimationFrame loop when no tile is animating.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTileRenderLoop } from '@/features/terminal-component-group/components/smallTileAnimationCanvas/useTileRenderLoop';
import { useSmallTileAnimations } from '@/hooks/useSmallTileAnimations';

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

describe('small tile animation spawning vs selected agent', () => {
  // Tiles spread across all 5 spawn groups (quadrants + bottom region)
  const everColoredTiles = new Set(['0,0', '0,10', '4,0', '4,10', '8,0']);

  function renderAnimations(selectedAgentId: string | null) {
    return renderHook(
      ({ agentId }: { agentId: string | null }) =>
        useSmallTileAnimations({
          enabled: true,
          viewportWidth: 1440,
          viewportHeight: 900,
          tileSize: 143,
          largeTileSize: 429,
          everColoredTiles,
          animationInterval: 800,
          selectedAgentId: agentId,
          scrollOffset: { x: 0, y: 0 },
        }),
      { initialProps: { agentId: selectedAgentId } },
    );
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('spawns square animations after the start delay when no agent is selected', () => {
    vi.useFakeTimers();
    const { result } = renderAnimations(null);

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(result.current.animatingTiles.length).toBeGreaterThan(0);
  });

  it('never spawns square animations while an agent is selected', () => {
    vi.useFakeTimers();
    const { result } = renderAnimations('agent-1');

    act(() => {
      vi.advanceTimersByTime(800 * 6);
    });

    expect(result.current.animatingTiles).toEqual([]);
  });

  it('clears in-flight square animations the moment an agent is selected', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderAnimations(null);

    act(() => {
      vi.advanceTimersByTime(800 * 3);
    });
    expect(result.current.animatingTiles.length).toBeGreaterThan(0);

    rerender({ agentId: 'agent-1' });
    expect(result.current.animatingTiles).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(800 * 4);
    });
    expect(result.current.animatingTiles).toEqual([]);
  });

  it('resumes spawning after the agent is deselected', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderAnimations('agent-1');

    act(() => {
      vi.advanceTimersByTime(800 * 3);
    });
    expect(result.current.animatingTiles).toEqual([]);

    rerender({ agentId: null });
    act(() => {
      vi.advanceTimersByTime(800 * 2);
    });

    expect(result.current.animatingTiles.length).toBeGreaterThan(0);
  });
});
