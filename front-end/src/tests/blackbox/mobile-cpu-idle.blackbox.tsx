/** Foreground CPU: work that cannot change a visible pixel is held or skipped. */
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shaderSpeeds: number[] = [];
vi.mock('@paper-design/shaders', () => ({
  liquidMetalFragmentShader: '',
  ShaderMount: class {
    constructor(
      _el: HTMLElement,
      _shader: string,
      _uniforms: unknown,
      _attrs: unknown,
      speed: number,
    ) {
      shaderSpeeds.push(speed);
    }
    setSpeed(speed: number) {
      shaderSpeeds.push(speed);
    }
    dispose() {}
  },
}));

import LiquidWhiteButton from '@/components/ui/liquid-white-button';
import AsciiLoader from '@/features/terminal-component-group/components/AsciiLoader';
import { useBatchElapsed } from '@/features/terminal-component-group/components/useBatchElapsed';
import { formatWorkDuration } from '@/features/terminal-component-group/hooks/codeSessionTurns';
import { coverApp, isAppCovered, uncoverApp } from '@/lib/appCover';

function fullScreenOverlay(background = 'rgb(39, 39, 37)'): HTMLElement {
  const overlay = document.createElement('div');
  overlay.style.backgroundColor = background;
  overlay.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight }) as DOMRect;
  document.body.appendChild(overlay);
  return overlay;
}

describe('app cover (opaque full-screen overlay over the app shell)', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
  });
  afterEach(() => {
    uncoverApp();
    document.body.innerHTML = '';
  });

  it('hides #root only behind an opaque overlay that spans the viewport, and restores it', () => {
    coverApp(fullScreenOverlay());
    expect(isAppCovered()).toBe(true);
    expect(root.style.visibility).toBe('hidden');
    uncoverApp();
    expect(isAppCovered()).toBe(false);
    expect(root.style.visibility).toBe('');
  });

  it('never covers for a translucent overlay, a partial one, or one inside the app', () => {
    coverApp(fullScreenOverlay('rgba(0, 0, 0, 0.6)'));
    const partial = fullScreenOverlay();
    partial.getBoundingClientRect = () =>
      ({ left: 40, top: 0, right: innerWidth, bottom: innerHeight }) as DOMRect;
    coverApp(partial);
    const inside = fullScreenOverlay();
    root.appendChild(inside);
    coverApp(inside);
    expect(isAppCovered()).toBe(false);
    expect(root.style.visibility).toBe('');
  });

  it('holds the ASCII loader frame while covered and resumes on uncover', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<AsciiLoader showWarmingUp={false} size="large" />);
      const frame = () => container.querySelector('pre[data-ascii-layer]')!.textContent;
      const first = frame();
      act(() => vi.advanceTimersByTime(40));
      expect(frame()).not.toBe(first);

      act(() => coverApp(fullScreenOverlay()));
      const held = frame();
      act(() => vi.advanceTimersByTime(2_000));
      expect(frame()).toBe(held);

      act(() => uncoverApp());
      act(() => vi.advanceTimersByTime(40));
      expect(frame()).not.toBe(held);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the send button shader while covered and restores its speed', () => {
    shaderSpeeds.length = 0;
    render(
      <LiquidWhiteButton>
        <span>go</span>
      </LiquidWhiteButton>,
    );
    expect(shaderSpeeds).toEqual([0.5]);
    act(() => coverApp(fullScreenOverlay()));
    act(() => uncoverApp());
    expect(shaderSpeeds).toEqual([0.5, 0, 0.5]);
  });
});

describe('batch elapsed clock re-renders only when its label can change', () => {
  afterEach(() => vi.useRealTimers());

  it('ticks every 100ms under a minute (tenths shown) and once per second after', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    let renders = 0;
    const startedAt = 1_000_000 - 30_000;
    const { result } = renderHook(() => {
      renders += 1;
      return useBatchElapsed(startedAt, true);
    });
    // One act per 100ms step: act would otherwise batch every tick into one render.
    const advance = (ms: number) => {
      for (let t = 0; t < ms; t += 100) act(() => vi.advanceTimersByTime(100));
    };
    renders = 0;
    advance(1_000);
    expect(renders).toBe(10);
    expect(result.current).toBe('31.0s');

    advance(29_000); // crosses one minute
    renders = 0;
    advance(10_000);
    expect(renders).toBe(10);
    expect(result.current).toBe(formatWorkDuration(70_000));
  });

  it('shows each whole second as it is reached', () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_250);
    const startedAt = 2_000_250 - 125_400; // 2m 05.4s elapsed
    const { result } = renderHook(() => useBatchElapsed(startedAt, true));
    expect(result.current).toBe('2m 05s');
    act(() => vi.advanceTimersByTime(599));
    expect(result.current).toBe('2m 05s');
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe('2m 06s');
  });
});
