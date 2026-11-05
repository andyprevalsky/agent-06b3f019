/**
 * Landing-page render budget (phones ran hot on the home screen). Each test
 * pins a per-frame cost that must stay off the hot path, with the visual
 * output unchanged:
 *  - the ASCII loader writes each 40ms frame into its <pre> layers without a
 *    React render, holds while the page is hidden, and is not recorded by
 *    session replay frame by frame (data-amp-block)
 *  - the opening caption's 20ms reveal ticks re-render the caption only, not
 *    the chat column (composer, loader) that owns the cycle
 */
import { act, render, renderHook, screen } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AsciiLoader from '@/features/terminal-component-group/components/AsciiLoader';
import engineFrames from '@/features/terminal-component-group/components/ascii-frames-engine.json';
import { OPENING_MESSAGES } from '@/features/terminal/config';
import {
  createOpeningAnimationStore,
  useOpeningAnimation,
  useOpeningAnimationState,
  type OpeningAnimationStore,
} from '@/features/terminal/hooks/useOpeningAnimation';

const FRAMES = engineFrames as string[];
let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function basePre(container: HTMLElement): HTMLPreElement {
  return container.querySelector('pre[data-ascii-layer="frame"]') as HTMLPreElement;
}

describe('ASCII loader frame ticks', () => {
  it('advances one frame per 40ms through every layer without re-rendering React', () => {
    const onRender = vi.fn();
    const { container } = render(
      <Profiler id="ascii" onRender={onRender}>
        <AsciiLoader
          showWarmingUp={false}
          size="large"
          variant="engine"
          cta={{ label: 'Join Waitlist', onClick: vi.fn() }}
        />
      </Profiler>,
    );
    const renders = onRender.mock.calls.length;
    expect(basePre(container).textContent).toBe(FRAMES[0]);

    act(() => vi.advanceTimersByTime(40 * 3));
    expect(basePre(container).textContent).toBe(FRAMES[3]);
    const prism = screen.getByTestId('opening-join-prism');
    const shadow = screen.getByTestId('opening-join-prism-shadow');
    expect(prism.textContent).toHaveLength(FRAMES[3].length);
    expect(shadow.textContent).toBe(prism.textContent);
    expect(onRender).toHaveBeenCalledTimes(renders);
  });

  it('fills the CTA pill with the same frame it shows beneath, keyed to the tick', () => {
    const { container } = render(
      <AsciiLoader
        showWarmingUp={false}
        variant="engine"
        cta={{ label: 'Go', onClick: vi.fn() }}
      />,
    );
    act(() => vi.advanceTimersByTime(40 * 5));
    const base = basePre(container).textContent ?? '';
    const pill = screen.getByTestId('opening-join-prism').textContent ?? '';
    for (let i = 0; i < base.length; i++) {
      if (base[i] !== ' ') expect(pill[i]).toBe(base[i]);
    }
    expect(pill).not.toMatch(/ /);
  });

  it('holds the frame while the page is hidden and resumes from it', () => {
    const { container } = render(<AsciiLoader showWarmingUp={false} variant="engine" />);
    act(() => vi.advanceTimersByTime(40 * 2));
    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => vi.advanceTimersByTime(40 * 50));
    expect(basePre(container).textContent).toBe(FRAMES[2]);

    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => vi.advanceTimersByTime(40));
    expect(basePre(container).textContent).toBe(FRAMES[3]);
  });

  it('holds while scrolled out of view', () => {
    let report: (entries: { isIntersecting: boolean }[]) => void = () => {};
    const original = window.IntersectionObserver;
    window.IntersectionObserver = class {
      constructor(callback: typeof report) {
        report = callback;
      }
      observe() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
    try {
      const { container } = render(<AsciiLoader showWarmingUp={false} variant="engine" />);
      act(() => report([{ isIntersecting: false }]));
      act(() => vi.advanceTimersByTime(40 * 10));
      expect(basePre(container).textContent).toBe(FRAMES[0]);
      act(() => report([{ isIntersecting: true }]));
      act(() => vi.advanceTimersByTime(40));
      expect(basePre(container).textContent).toBe(FRAMES[1]);
    } finally {
      window.IntersectionObserver = original;
    }
  });

  it('keeps every animated layer out of session replay recording', () => {
    const { container } = render(
      <AsciiLoader
        showWarmingUp={false}
        variant="engine"
        cta={{ label: 'Go', onClick: vi.fn() }}
      />,
    );
    const layers = container.querySelectorAll('pre');
    expect(layers).toHaveLength(3);
    for (const layer of layers) expect(layer).toHaveAttribute('data-amp-block');
    // The CTA button itself stays recorded (clicks keep their target).
    expect(screen.getByTestId('opening-join-waitlist').closest('[data-amp-block]')).toBeNull();
  });

  it('runs no dots timer when the warming-up line is not shown', () => {
    render(<AsciiLoader showWarmingUp={false} variant="engine" />);
    // Only the frame ticker remains.
    expect(vi.getTimerCount()).toBe(1);
  });
});

describe('opening caption cycle', () => {
  function caption(store: OpeningAnimationStore) {
    return store.getSnapshot();
  }

  it('reveals, pauses, fades and advances on the designed timings', () => {
    const store = createOpeningAnimationStore();
    store.setRunning(true);
    act(() => vi.advanceTimersByTime(20));
    expect(caption(store).revealProgress).toBe(2);
    act(() => vi.advanceTimersByTime(20 * 49));
    expect(caption(store)).toMatchObject({ revealProgress: 100, animationPhase: 'paused' });
    act(() => vi.advanceTimersByTime(OPENING_MESSAGES[0][1]));
    expect(caption(store).animationPhase).toBe('fading');
    act(() => vi.advanceTimersByTime(300));
    expect(caption(store)).toMatchObject({
      currentMessageIndex: 1,
      animationPhase: 'revealing',
      revealProgress: 0,
    });
    store.setRunning(false);
  });

  it('keeps the last message and stops ticking once typing completes', () => {
    const store = createOpeningAnimationStore();
    store.setRunning(true);
    act(() => vi.advanceTimersByTime(60_000));
    expect(caption(store)).toMatchObject({
      currentMessageIndex: OPENING_MESSAGES.length - 1,
      revealProgress: 100,
      isTypingComplete: true,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds while an agent is selected or the network loads, then continues', () => {
    const { result, rerender } = renderHook(
      ({ agent, loading }: { agent: string | null; loading: boolean }) =>
        useOpeningAnimation(agent, loading),
      { initialProps: { agent: null as string | null, loading: true } },
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(caption(result.current).revealProgress).toBe(0);

    rerender({ agent: null, loading: false });
    act(() => vi.advanceTimersByTime(200));
    expect(caption(result.current).revealProgress).toBe(20);

    rerender({ agent: 'agent-1', loading: false });
    act(() => vi.advanceTimersByTime(1000));
    expect(caption(result.current).revealProgress).toBe(20);

    rerender({ agent: null, loading: false });
    act(() => vi.advanceTimersByTime(20));
    expect(caption(result.current).revealProgress).toBe(22);
  });

  it('re-renders only the subscribed caption on each reveal tick, not its owner', () => {
    const ownerRenders = vi.fn();
    const captionRenders = vi.fn();
    function Caption({ store }: { store: OpeningAnimationStore }) {
      captionRenders(useOpeningAnimationState(store).revealProgress);
      return null;
    }
    function Owner() {
      ownerRenders();
      const store = useOpeningAnimation(null, false);
      return <Caption store={store} />;
    }
    render(<Owner />);
    const ownerBefore = ownerRenders.mock.calls.length;
    act(() => vi.advanceTimersByTime(20 * 10));
    expect(ownerRenders).toHaveBeenCalledTimes(ownerBefore);
    expect(captionRenders).toHaveBeenLastCalledWith(20);
  });
});
