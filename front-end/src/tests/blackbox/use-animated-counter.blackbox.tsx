import { act, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const motionMocks = vi.hoisted(() => {
  const set = vi.fn();

  return {
    animate: vi.fn(),
    motionValue: { set },
    set,
    stop: vi.fn(),
  };
});

vi.mock('framer-motion', () => ({
  animate: motionMocks.animate,
  useMotionValue: () => motionMocks.motionValue,
}));

import { StreamingMetric } from '@/features/terminal-component-group/components/StreamingMetric';
import { useAnimatedCounter } from '@/hooks/useAnimatedCounter';

interface AnimationOptions {
  duration: number;
  ease: string;
  onUpdate: (latest: number) => void;
}

describe('useAnimatedCounter', () => {
  beforeEach(() => {
    motionMocks.animate.mockReset();
    motionMocks.set.mockReset();
    motionMocks.stop.mockReset();
    motionMocks.animate.mockReturnValue({ stop: motionMocks.stop });
  });

  it('shows a positive initial target synchronously without animating up from zero', () => {
    const { result } = renderHook(() => useAnimatedCounter(12.6, 0.3));

    expect(result.current).toBe(13);
    expect(motionMocks.set).toHaveBeenCalledWith(12.6);
    expect(motionMocks.animate).not.toHaveBeenCalled();
  });

  it('shows the first streamed value immediately, then animates later positive increments', () => {
    const { result, rerender } = renderHook(({ target }) => useAnimatedCounter(target, 0.3), {
      initialProps: { target: 0 },
    });

    rerender({ target: 8 });

    expect(result.current).toBe(8);
    expect(motionMocks.set).toHaveBeenLastCalledWith(8);
    expect(motionMocks.animate).not.toHaveBeenCalled();

    rerender({ target: 20 });

    expect(result.current).toBe(8);
    expect(motionMocks.animate).toHaveBeenCalledTimes(1);
    const options = motionMocks.animate.mock.calls[0]?.[2] as AnimationOptions;
    expect(options.duration).toBe(0.3);
    expect(options.ease).toBe('easeOut');

    act(() => options.onUpdate(13.4));
    expect(result.current).toBe(13);
  });

  it('resets to zero and immediately displays the next stream first value', () => {
    const { result, rerender } = renderHook(({ target }) => useAnimatedCounter(target, 0.3), {
      initialProps: { target: 5 },
    });

    rerender({ target: 0 });
    expect(result.current).toBe(0);
    expect(motionMocks.set).toHaveBeenLastCalledWith(0);

    rerender({ target: 4 });
    expect(result.current).toBe(4);
    expect(motionMocks.set).toHaveBeenLastCalledWith(4);
    expect(motionMocks.animate).not.toHaveBeenCalled();
  });

  it('paints the first real token target in StreamingMetric in the same rerender', () => {
    const { result, rerender: rerenderHook } = renderHook(
      ({ target }) => useAnimatedCounter(target, 0.3),
      { initialProps: { target: 0 } },
    );
    const metric = render(<StreamingMetric tokenCount={0} animatedTokenCount={result.current} />);

    expect(screen.queryByText(/tokens$/)).not.toBeInTheDocument();

    rerenderHook({ target: 9 });
    metric.rerender(<StreamingMetric tokenCount={9} animatedTokenCount={result.current} />);

    expect(screen.getByText(/9 tokens$/)).toBeInTheDocument();
  });
});
