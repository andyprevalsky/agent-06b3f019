import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackgroundPattern } from '@/features/terminal/components/BackgroundPattern';
import {
  GridEnergyPills,
  MobileGridEnergyPillsCanvas,
} from '@/features/terminal/components/GridEnergyPills';

const setViewport = (width: number, height: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
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

  it('uses canvas energy motion instead of animated SVG on mobile', () => {
    setViewport(390, 844);

    const { container } = renderBackgroundPattern();

    expect(
      container.querySelector('[data-testid="terminal-grid-energy-canvas"]'),
    ).toBeInTheDocument();
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

  it('draws mobile energy motion through canvas animation frames', () => {
    setViewport(390, 844);
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
    document.documentElement.classList.add('dark');
    let frameCallback: FrameRequestCallback | null = null;
    const gradient = { addColorStop: vi.fn() };
    const ctx = {
      beginPath: vi.fn(),
      clearRect: vi.fn(),
      clip: vi.fn(),
      closePath: vi.fn(),
      createLinearGradient: vi.fn(() => gradient),
      fill: vi.fn(),
      fillStyle: '',
      lineTo: vi.fn(),
      moveTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      rect: vi.fn(),
      restore: vi.fn(),
      save: vi.fn(),
      setTransform: vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameCallback = callback;
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});

    render(<MobileGridEnergyPillsCanvas patternOffset={{ x: 0, y: 0 }} selectedAgentId={null} />);

    act(() => {
      frameCallback?.(1000);
    });

    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(ctx.clip).toHaveBeenCalledWith('evenodd');
    expect(ctx.createLinearGradient).toHaveBeenCalledTimes(8);
    expect(ctx.fill).toHaveBeenCalledTimes(8);
    expect(gradient.addColorStop).toHaveBeenCalledWith(0.52, 'rgba(255, 255, 255, 1)');
  });
});
