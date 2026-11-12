import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundPattern } from '@/features/terminal/components/BackgroundPattern';
import {
  GridEnergyPills,
  MobileGridEnergyPills,
} from '@/features/terminal/components/GridEnergyPills';

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
};

/**
 * MOBILE_FLOWS at 390x844, patternOffset {0, 0}, derived by hand from the
 * former canvas geometry: travel runs from -143 - length to extent + 143
 * (reverse flows the other way); the cross axis sits on grid line
 * firstLine + round((ceil(extent / 143) + 2) * lineRatio) * 143, minus half
 * the 5px pill thickness.
 */
const EXPECTED_390X844 = {
  'h-01': {
    axis: 'x',
    size: [66, 5],
    duration: 10,
    delay: -1,
    from: 'translate3d(-209px, -2.5px, 0)',
    to: 'translate3d(533px, -2.5px, 0)',
  },
  'h-05': {
    axis: 'x',
    size: [70, 5],
    duration: 11,
    delay: -8,
    from: 'translate3d(-213px, 283.5px, 0)',
    to: 'translate3d(533px, 283.5px, 0)',
  },
  'h-09': {
    axis: 'x',
    size: [74, 5],
    duration: 12,
    delay: -4,
    from: 'translate3d(-217px, 569.5px, 0)',
    to: 'translate3d(533px, 569.5px, 0)',
  },
  'h-13': {
    axis: 'x',
    size: [94, 5],
    duration: 15,
    delay: -10,
    from: 'translate3d(-237px, 855.5px, 0)',
    to: 'translate3d(533px, 855.5px, 0)',
  },
  'v-02': {
    axis: 'y',
    size: [5, 84],
    duration: 14,
    delay: -12,
    from: 'translate3d(140.5px, 987px, 0)',
    to: 'translate3d(140.5px, -227px, 0)',
  },
  'v-06': {
    axis: 'y',
    size: [5, 66],
    duration: 10,
    delay: -14,
    from: 'translate3d(283.5px, 987px, 0)',
    to: 'translate3d(283.5px, -209px, 0)',
  },
  'v-10': {
    axis: 'y',
    size: [5, 60],
    duration: 9,
    delay: -8,
    from: 'translate3d(426.5px, 987px, 0)',
    to: 'translate3d(426.5px, -203px, 0)',
  },
  'v-14': {
    axis: 'y',
    size: [5, 64],
    duration: 10,
    delay: -3,
    from: 'translate3d(712.5px, 987px, 0)',
    to: 'translate3d(712.5px, -207px, 0)',
  },
} as const;

const energyLayer = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="terminal-grid-energy-canvas"]')!;

const mobilePills = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('.rose-mobile-energy-pill'));

const styleText = (container: HTMLElement) =>
  Array.from(energyLayer(container).querySelectorAll('style'))
    .map((style) => style.textContent ?? '')
    .join('\n');

/** @keyframes name -> body, parsed from the layer's own <style>. */
const keyframeRules = (container: HTMLElement) =>
  new Map(
    Array.from(styleText(container).matchAll(/@keyframes (\S+) \{ (.*) \}$/gm)).map(
      ([, name, body]) => [name, body],
    ),
  );

type Point = { along: number; line: number };

/** translate3d(x, y, 0) -> {along, line} for a flow axis. */
const parseTranslate = (transform: string, axis: 'x' | 'y'): Point => {
  const [x, y] = transform
    .match(/translate3d\(([-\d.]+)px, ([-\d.]+)px, 0\)/)!
    .slice(1)
    .map(Number);
  return axis === 'x' ? { along: x, line: y } : { along: y, line: x };
};

type Frame = { offset: number; along: number; line: number; step: boolean };

/** Parses `0% { transform: ...; } 12.5% { ...; animation-timing-function: step-end; }` (or from/to). */
const parseKeyframes = (body: string, axis: 'x' | 'y'): Frame[] =>
  Array.from(
    body.matchAll(
      /(from|to|[\d.]+%) \{ transform: ([^;]+);( animation-timing-function: step-end;)? \}/g,
    ),
  ).map(([, offset, transform, step]) => ({
    offset: offset === 'from' ? 0 : offset === 'to' ? 1 : Number(offset.slice(0, -1)) / 100,
    ...parseTranslate(transform, axis),
    step: Boolean(step),
  }));

/** Position at cycle fraction f: linear segments, step-end segments hold their start. */
const positionAt = (frames: Frame[], f: number): number => {
  if (f <= frames[0].offset) return frames[0].along;
  for (let i = 0; i < frames.length - 1; i += 1) {
    const [a, b] = [frames[i], frames[i + 1]];
    if (f > b.offset) continue;
    if (a.step) return f < b.offset ? a.along : b.along;
    return a.along + ((f - a.offset) / (b.offset - a.offset)) * (b.along - a.along);
  }
  return frames[frames.length - 1].along;
};

type Rect = [number, number, number, number];

/** The even-odd mask rects from the layer's clip-path (x0, y0, x1, y1). */
const maskRects = (layer: HTMLElement): Rect[] =>
  Array.from(layer.style.clipPath.matchAll(/M([-\d.]+) ([-\d.]+)H([-\d.]+)V([-\d.]+)H/g)).map(
    ([, x0, y0, x1, y1]) => [Number(x0), Number(y0), Number(x1), Number(y1)],
  );

/** Independent check: does any point of the box show through the mask inside the layer? */
const boxShows = (rects: Rect[], width: number, height: number, box: Rect, margin = 1) => {
  const [bx0, by0, bx1, by1] = [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
  // Sample strictly inside the layer (its edges are where mask parity is ambiguous).
  for (let x = Math.max(0.25, bx0); x < Math.min(width, bx1); x += 0.5) {
    for (let y = Math.max(0.25, by0); y < Math.min(height, by1); y += 0.5) {
      const cover = rects.filter(([x0, y0, x1, y1]) => x > x0 && x < x1 && y > y0 && y < y1);
      if (cover.length % 2 === 1) return true;
    }
  }
  return false;
};

/**
 * Every flow must look exactly like the plain linear from -> to animation:
 * wherever a mounted pill's keyframed position differs from the linear one,
 * both positions are fully masked; an unmounted flow is masked all cycle long.
 */
const expectSameVisibleMotion = (
  container: HTMLElement,
  expected: Record<string, { axis: 'x' | 'y'; size: readonly number[]; from: string; to: string }>,
) => {
  const layer = energyLayer(container);
  const [width, height] = [parseFloat(layer.style.width), parseFloat(layer.style.height)];
  const rects = maskRects(layer);
  const keyframes = keyframeRules(container);
  const mounted = new Map(mobilePills(container).map((pill) => [pill.dataset.flowId!, pill]));
  expect(layer).toHaveAttribute('data-flow-count', String(mounted.size));
  for (const [id, flow] of Object.entries(expected)) {
    const from = parseTranslate(flow.from, flow.axis);
    const to = parseTranslate(flow.to, flow.axis);
    const [length, thickness] = flow.axis === 'x' ? flow.size : [flow.size[1], flow.size[0]];
    const box = (along: number): Rect =>
      flow.axis === 'x'
        ? [along, from.line, along + length, from.line + thickness]
        : [from.line, along, from.line + thickness, along + length];
    const pill = mounted.get(id);
    const frames = pill
      ? parseKeyframes(keyframes.get(pill.style.animation.split(' ')[0])!, flow.axis)
      : null;
    frames?.forEach((frame) => expect(frame.line).toBeCloseTo(from.line, 6));
    for (let f = 0; f <= 1; f += 1 / 2000) {
      const linear = from.along + f * (to.along - from.along);
      if (!frames) {
        expect(boxShows(rects, width, height, box(linear)), `${id} hidden at ${f}`).toBe(false);
        continue;
      }
      const parked = positionAt(frames, f);
      if (Math.abs(parked - linear) < 1e-3) continue;
      expect(boxShows(rects, width, height, box(linear)), `${id} linear at ${f}`).toBe(false);
      expect(boxShows(rects, width, height, box(parked)), `${id} parked at ${f}`).toBe(false);
    }
  }
};

const renderEnergyPills = () =>
  render(
    <svg>
      <GridEnergyPills idPrefix="test-energy" patternOffset={{ x: 0, y: 0 }} />
    </svg>,
  );

const renderBackgroundPattern = () =>
  render(
    <BackgroundPattern
      patternOffset={{ x: 0, y: 0 }}
      tileColors={new Map()}
      colorPalette={[]}
      animationResetKey={0}
      animationComplete={true}
      currentFrame={0}
      selectedAgentId={null}
    />,
  );

describe('grid energy pill performance budget', () => {
  afterEach(() => {
    setViewport(1440, 900);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    document.documentElement.classList.remove('dark');
    vi.restoreAllMocks();
  });

  it('keeps the full animated energy layer on desktop', () => {
    setViewport(1440, 900);

    const { container } = renderEnergyPills();

    expect(container.querySelector('.grid-energy-pill-flow')).toHaveAttribute(
      'data-flow-count',
      '30',
    );
    expect(container.querySelectorAll('[attributeName="transform"]')).toHaveLength(30);
  });

  it('keeps mobile energy pills visible without mounting the full desktop animation budget', () => {
    setViewport(390, 844);

    const { container } = renderEnergyPills();

    expect(container.querySelector('.grid-energy-pill-flow')).toHaveAttribute(
      'data-flow-count',
      '8',
    );
    expect(container.querySelectorAll('[attributeName="transform"]')).toHaveLength(8);
  });

  it('uses compositor-animated DOM pills instead of animated SVG or a canvas on mobile', () => {
    setViewport(390, 844);

    const { container } = renderBackgroundPattern();

    const layer = energyLayer(container);
    expect(layer.tagName).toBe('DIV');
    expect(layer).toHaveClass('absolute', 'inset-0', 'pointer-events-none', 'z-[4]');
    // Only flows whose track ever shows through the mask at 390x844 are mounted.
    expect(layer).toHaveAttribute('data-flow-count', '3');
    expect(mobilePills(container)).toHaveLength(3);
    expect(container.querySelectorAll('canvas')).toHaveLength(0);
    expect(
      container.querySelector('[data-testid="terminal-grid-energy-layer"]'),
    ).not.toBeInTheDocument();
    expect(
      container.querySelector('[data-testid="terminal-small-tile-animation-canvas"]'),
    ).not.toBeInTheDocument();
    expect(container.querySelectorAll('[attributeName="transform"]')).toHaveLength(0);
  });

  it('keeps the square/dot tile animation canvas on desktop only', async () => {
    setViewport(1440, 900);

    const { container } = renderBackgroundPattern();

    // Cold deferred-module compilation shares the existing theme loader budget.
    await waitFor(
      () =>
        expect(
          container.querySelector('[data-testid="terminal-small-tile-animation-canvas"]'),
        ).toBeInTheDocument(),
      { timeout: 15000 },
    );
  });

  it('moves the mobile pills that can show with CSS transform keyframes on their linear tracks and no frame loop', () => {
    setViewport(390, 844);
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame');
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const addDocumentListener = vi.spyOn(document, 'addEventListener');

    const { container } = render(
      <MobileGridEnergyPills patternOffset={{ x: 0, y: 0 }} selectedAgentId={null} />,
    );

    const pills = mobilePills(container);
    // h-05 / h-13 sit under the tile / input cutouts, v-10 / v-14 lie past the
    // right edge: never visible, so never mounted.
    expect(pills.map((pill) => pill.dataset.flowId)).toEqual(['h-01', 'v-02', 'v-06']);
    for (const pill of pills) {
      const expected = EXPECTED_390X844[pill.dataset.flowId as keyof typeof EXPECTED_390X844];
      const [, ...timing] = pill.style.animation.split(' ');
      expect(timing.join(' ')).toBe(`${expected.duration}s linear ${expected.delay}s infinite`);
      expect(pill.style.width).toBe(`${expected.size[0]}px`);
      expect(pill.style.height).toBe(`${expected.size[1]}px`);
      expect(pill.style.left).toBe('');
      expect(pill.style.top).toBe('');
      expect(pill).toHaveClass(
        'rose-mobile-energy-pill',
        `rose-mobile-energy-pill-${expected.axis}`,
      );
    }
    expect(keyframeRules(container).size).toBe(3);
    // Same on-screen motion as the plain from -> to animation, frame for frame.
    expectSameVisibleMotion(container, EXPECTED_390X844);
    // Masked stretches hold still (step-end) instead of moving under the mask.
    expect(styleText(container)).toContain('animation-timing-function: step-end');
    expect(styleText(container)).toContain('border-radius: 2.5px');

    // No per-frame JS: no animation-frame loop, no canvas context, no visibility
    // polling (the browser pauses CSS animations while the document is hidden).
    expect(animationFrame).not.toHaveBeenCalled();
    expect(getContext).not.toHaveBeenCalled();
    expect(addDocumentListener.mock.calls.map(([type]) => type)).not.toContain('visibilitychange');
  });

  it('clips mobile pills with the even-odd viewport / large tile / input-area mask', () => {
    setViewport(390, 844);
    const offset = { x: 0, y: 0 };

    const { container, rerender } = render(
      <MobileGridEnergyPills patternOffset={offset} selectedAgentId={null} />,
    );
    const layer = energyLayer(container);

    expect(layer.style.width).toBe('390px');
    expect(layer.style.height).toBe('844px');
    expect(layer).toHaveClass('overflow-hidden');
    // Landing controls (no agent selected): 340px input clearance.
    expect(layer.style.clipPath).toBe(
      "path(evenodd, 'M0 0H390V844H0Z M-18.4 124.2H408.4V551H-18.4Z M0 504H390V844H0Z')",
    );

    rerender(<MobileGridEnergyPills patternOffset={offset} selectedAgentId="agent-1" />);
    // Query input (agent selected): 260px input clearance.
    expect(layer.style.clipPath).toBe(
      "path(evenodd, 'M0 0H390V844H0Z M-18.4 124.2H408.4V551H-18.4Z M0 584H390V844H0Z')",
    );
    // The parked stretches follow the new mask; on-screen motion is unchanged.
    expectSameVisibleMotion(container, EXPECTED_390X844);
  });

  it('re-measures the mask and keyframes on resize and pins each animation phase once', () => {
    setViewport(390, 844);
    const pinned: Array<{ startTime: number | null }> = [];
    const getAnimations = vi.fn((options?: GetAnimationsOptions) => {
      expect(options).toEqual({ subtree: true });
      const batch = Array.from({ length: 8 }, () => ({ startTime: null as number | null }));
      pinned.push(...batch);
      return batch as unknown as Animation[];
    });
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
      configurable: true,
      value: getAnimations,
    });

    try {
      const { container, rerender } = render(
        <MobileGridEnergyPills patternOffset={{ x: 0, y: 0 }} selectedAgentId={null} />,
      );
      expect(getAnimations).toHaveBeenCalledTimes(1);
      expect(pinned.map((animation) => animation.startTime)).toEqual(Array(8).fill(0));

      // Re-render with equal geometry (new object identity): no re-pin.
      rerender(<MobileGridEnergyPills patternOffset={{ x: 0, y: 0 }} selectedAgentId={null} />);
      expect(getAnimations).toHaveBeenCalledTimes(1);

      const namesBefore = [...keyframeRules(container).keys()];
      act(() => {
        setViewport(390, 300);
        window.dispatchEvent(new Event('resize'));
      });
      const layer = energyLayer(container);
      expect(layer.style.height).toBe('300px');
      // Short viewport: the input cutout starts at 0 and overlaps the large tile.
      expect(layer.style.clipPath).toBe(
        "path(evenodd, 'M0 0H390V300H0Z M-18.4 -93.4H408.4V333.4H-18.4Z M0 0H390V340H0Z')",
      );
      const namesAfter = [...keyframeRules(container).keys()];
      expect(namesAfter.length).toBe(mobilePills(container).length);
      // Vertical flows travel the new height; horizontal flows move to the new
      // grid lines (only h-01 stays on line 0, so its keyframes are reused).
      expect(namesAfter.filter((name) => namesBefore.includes(name))).toHaveLength(1);
      expectSameVisibleMotion(container, {
        'h-01': {
          axis: 'x',
          size: [66, 5],
          from: 'translate3d(-209px, -2.5px, 0)',
          to: 'translate3d(533px, -2.5px, 0)',
        },
        'h-05': {
          axis: 'x',
          size: [70, 5],
          from: 'translate3d(-213px, 140.5px, 0)',
          to: 'translate3d(533px, 140.5px, 0)',
        },
        'v-02': {
          axis: 'y',
          size: [5, 84],
          from: 'translate3d(140.5px, 443px, 0)',
          to: 'translate3d(140.5px, -227px, 0)',
        },
      });
      expect(getAnimations).toHaveBeenCalledTimes(2);
      expect(pinned.map((animation) => animation.startTime)).toEqual(Array(16).fill(0));
    } finally {
      delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations;
    }
  });

  it('keeps mobile pills flowing under prefers-reduced-motion, as the canvas did', () => {
    setViewport(390, 844);
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          addListener: vi.fn(),
          removeListener: vi.fn(),
          onchange: null,
          dispatchEvent: vi.fn(),
        }) as MediaQueryList,
    );

    const { container } = renderBackgroundPattern();

    expect(mobilePills(container)).toHaveLength(3);
    mobilePills(container).forEach((pill) => expect(pill.style.animation).toContain('infinite'));
    expect(styleText(container)).not.toContain('prefers-reduced-motion');
    expect(styleText(container)).not.toMatch(/display:\s*none/);
  });
});
