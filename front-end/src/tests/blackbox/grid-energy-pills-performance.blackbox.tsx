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
    expect(layer).toHaveAttribute('data-flow-count', '8');
    expect(mobilePills(container)).toHaveLength(8);
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

  it('moves exactly 8 mobile pills with linear infinite CSS transform keyframes and no frame loop', () => {
    setViewport(390, 844);
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame');
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const addDocumentListener = vi.spyOn(document, 'addEventListener');

    const { container } = render(
      <MobileGridEnergyPills patternOffset={{ x: 0, y: 0 }} selectedAgentId={null} />,
    );

    const pills = mobilePills(container);
    expect(pills.map((pill) => pill.dataset.flowId)).toEqual(Object.keys(EXPECTED_390X844));
    const keyframes = keyframeRules(container);
    for (const pill of pills) {
      const expected = EXPECTED_390X844[pill.dataset.flowId as keyof typeof EXPECTED_390X844];
      const [name, ...timing] = pill.style.animation.split(' ');
      expect(timing.join(' ')).toBe(`${expected.duration}s linear ${expected.delay}s infinite`);
      // Only transform animates: one translate3d from the off-screen start to the off-screen end.
      expect(keyframes.get(name)).toBe(
        `from { transform: ${expected.from}; } to { transform: ${expected.to}; }`,
      );
      expect(pill.style.width).toBe(`${expected.size[0]}px`);
      expect(pill.style.height).toBe(`${expected.size[1]}px`);
      expect(pill.style.left).toBe('');
      expect(pill.style.top).toBe('');
      expect(pill).toHaveClass(
        'rose-mobile-energy-pill',
        `rose-mobile-energy-pill-${expected.axis}`,
      );
    }
    expect(keyframes.size).toBe(8);
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
    const namesBefore = mobilePills(container).map((pill) => pill.style.animation);

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
    // A mask change never restarts the pill animations.
    expect(mobilePills(container).map((pill) => pill.style.animation)).toEqual(namesBefore);
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
      expect(namesAfter).toHaveLength(8);
      // Vertical flows travel the new height; horizontal flows move to the new
      // grid lines (only h-01 stays on line 0, so its keyframes are reused).
      expect(namesAfter.filter((name) => namesBefore.includes(name))).toHaveLength(1);
      const after = keyframeRules(container);
      const rule = (flowId: string) =>
        after.get(
          mobilePills(container)
            .find((pill) => pill.dataset.flowId === flowId)!
            .style.animation.split(' ')[0],
        );
      expect(rule('h-01')).toBe(
        'from { transform: translate3d(-209px, -2.5px, 0); } to { transform: translate3d(533px, -2.5px, 0); }',
      );
      expect(rule('h-05')).toBe(
        'from { transform: translate3d(-213px, 140.5px, 0); } to { transform: translate3d(533px, 140.5px, 0); }',
      );
      expect(rule('v-02')).toBe(
        'from { transform: translate3d(140.5px, 443px, 0); } to { transform: translate3d(140.5px, -227px, 0); }',
      );
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

    expect(mobilePills(container)).toHaveLength(8);
    mobilePills(container).forEach((pill) => expect(pill.style.animation).toContain('infinite'));
    expect(styleText(container)).not.toContain('prefers-reduced-motion');
    expect(styleText(container)).not.toMatch(/display:\s*none/);
  });
});
