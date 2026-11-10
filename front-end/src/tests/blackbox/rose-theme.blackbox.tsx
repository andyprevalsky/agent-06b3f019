/**
 * Rose Desktop dark mode (UI ledger rows 25/52/62): useRoseTheme() toggles
 * light <-> dark per user, dark adds html.dark and the calm dark background,
 * and light mode stays byte-identical to the stock UI. The index.css
 * contracts (scrollbars, dark palette tokens) live in rose-theme-css.blackbox.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flushSync } from 'react-dom';

// Resolve the real lazy-renderer module with the fixture dependencies.
// The bounded assertion still waits for its mount and passive canvas sizing.
import '@/features/terminal-component-group/components/SmallTileAnimationCanvasRenderer';

import AgentStatusIndicator from '@/features/terminal-component-group/components/AgentStatusIndicator';
import type { AgentRunStatus } from '@/features/terminal-component-group/components/agentRunState';
import { MobileGridEnergyPills } from '@/features/terminal/components/GridEnergyPills';
import { roseThemeStorageKey } from '@/features/rose-theme';
import Terminal from '@/pages/Terminal';

import { renderWithProviders } from './test-wrapper';
import {
  DESKTOP_VIEWPORT,
  MOBILE_VIEWPORT,
  ROSE_THEME_USER,
  backgroundElement,
  headerElement,
  headerPillMarkup,
  popularGoalsElement,
  queryBoxElement,
  queryBoxMarkup,
  readLightMarkup,
  setViewport,
  themed,
  withLayoutPhaseProbe,
} from './rose-theme.fixtures';

const OTHER_USER = '8283e892-b0a4-4298-9ef7-b95bcc67e46b';
const SILVER = '#d6d6d2';
/** SmallTileAnimationCanvas dot colours (renderTiles resolveDotColor). */
const LIGHT_DOT = 'rgba(229, 231, 235, 0.8)';
/** Mobile energy pill gradient stops (CSS variables keyed on html.dark), soft/core/tail. */
const DARK_PILL_STOPS = ['0.42', '1', '0.34'];
const LIGHT_PILL_STOPS = ['0.34', '0.95', '0.28'];

function mobileEnergyPills() {
  return Array.from(document.querySelectorAll<HTMLElement>('.rose-mobile-energy-pill'));
}

/** The resolved soft/core/tail stops and opacity of every mobile pill. */
function mobilePillPaint() {
  return new Set(
    mobileEnergyPills().map((pill) => {
      const style = getComputedStyle(pill);
      const stops = ['soft', 'core', 'tail'].map((stop) =>
        style.getPropertyValue(`--energy-pill-${stop}-stop`).trim(),
      );
      return JSON.stringify({ stops, opacity: pill.style.opacity });
    }),
  );
}

const pillPaint = (stops: string[], opacity: string) =>
  new Set([JSON.stringify({ stops, opacity })]);

/** 2D context fake that records globalAlpha + fillStyle at each fill; rAF only runs when asked. */
function installFakeCanvas() {
  const alphaAtFill: number[] = [];
  const fillStyleAtFill: string[] = [];
  let alphaWrites = 0;
  let alpha = 1;
  let frame: FrameRequestCallback | null = null;
  let framesRun = 0;
  const gradient = { addColorStop: vi.fn() };
  const ctx = {
    arc: vi.fn(),
    beginPath: vi.fn(),
    canvas: { width: 1440, height: 900 },
    clearRect: vi.fn(),
    clip: vi.fn(),
    closePath: vi.fn(),
    createLinearGradient: vi.fn(() => gradient),
    fill: vi.fn(() => {
      alphaAtFill.push(alpha);
      fillStyleAtFill.push(ctx.fillStyle);
    }),
    fillStyle: '',
    imageSmoothingEnabled: true,
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(value: number) {
      alphaWrites += 1;
      alpha = value;
    },
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    rect: vi.fn(),
    restore: vi.fn(() => {
      alpha = 1;
    }),
    save: vi.fn(),
    setTransform: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frame = cb;
    return 1;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  return {
    alphaAtFill,
    fillStyleAtFill,
    clearRect: ctx.clearRect,
    gradient,
    alphaWrites: () => alphaWrites,
    framesRun: () => framesRun,
    runFrame(now: number) {
      framesRun += 1;
      frame?.(now);
    },
  };
}

/**
 * Click the theme toggle the way a user does, committed synchronously
 * (flushSync, outside act) so assertions see exactly what the commit
 * produced: no timers, animation frames or deferred effects in between.
 */
function toggleThemeInOneCommit() {
  const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    flushSync(() => screen.getByTestId('theme-toggle').click());
  } finally {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}

function storeDark(userId: string) {
  localStorage.setItem(roseThemeStorageKey(userId), 'dark');
}

function htmlIsDark() {
  return document.documentElement.classList.contains('dark');
}

function themedMarkup() {
  return `${screen.getByTestId('themed').innerHTML}\n`;
}

function gridLayer() {
  return screen.getByTestId('terminal-grid-background-layer');
}

beforeEach(() => {
  localStorage.clear();
  setViewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
});

afterEach(() => {
  for (const cookie of document.cookie.split(';')) {
    const key = cookie.trim().split('=')[0];
    if (key.startsWith('rose-theme')) document.cookie = `${key}=; Max-Age=0; Path=/`;
  }
  document.documentElement.classList.remove('dark');
  localStorage.clear();
  vi.restoreAllMocks();
  setViewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
});

describe('light mode is unchanged (markup frozen before dark mode existed)', () => {
  it('desktop background renders the stock markup byte-for-byte', async () => {
    renderWithProviders(themed(backgroundElement()));
    await screen.findByTestId('terminal-small-tile-animation-canvas', {}, { timeout: 15000 });
    // The layer canvases get their pixel size in a later effect; under suite load
    // the tile canvas can mount first, so wait for the frozen markup to settle.
    await waitFor(() => expect(themedMarkup()).toBe(readLightMarkup('backgroundDesktop')), {
      timeout: 15000,
    });
    expect(htmlIsDark()).toBe(false);
  }, 20000);

  it('mobile background renders the stock markup byte-for-byte', () => {
    setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
    renderWithProviders(themed(backgroundElement()));
    expect(themedMarkup()).toBe(readLightMarkup('backgroundMobile'));
  });

  it('desktop header pill keeps the stock classes and inline drip styles', () => {
    renderWithProviders(themed(headerElement()));
    expect(headerPillMarkup(screen.getByTestId('themed'))).toBe(readLightMarkup('headerDesktop'));
  });

  it('without a theme provider (shared/benchmark views) everything is stock', async () => {
    const { container } = renderWithProviders(backgroundElement());
    await screen.findByTestId('terminal-small-tile-animation-canvas');
    await waitFor(() =>
      expect(`${container.innerHTML}\n`).toBe(readLightMarkup('backgroundDesktop')),
    );
  });

  it('toggling dark then back to light restores the exact stock markup', async () => {
    const user = userEvent.setup();
    renderWithProviders(themed(backgroundElement()));
    await screen.findByTestId('terminal-small-tile-animation-canvas');
    await user.click(screen.getByTestId('theme-toggle'));
    expect(themedMarkup()).not.toBe(readLightMarkup('backgroundDesktop'));
    await user.click(screen.getByTestId('theme-toggle'));
    expect(themedMarkup()).toBe(readLightMarkup('backgroundDesktop'));
    expect(htmlIsDark()).toBe(false);
  });

  it('flagged query box keeps the stock drip surface, marble, textarea and model chip', () => {
    renderWithProviders(themed(queryBoxElement()));
    expect(queryBoxMarkup(screen.getByTestId('themed'))).toBe(readLightMarkup('queryBoxDesktop'));
  });

  it('toggling dark then back to light restores the exact stock query box', async () => {
    const user = userEvent.setup();
    renderWithProviders(themed(queryBoxElement()));
    const box = () => queryBoxMarkup(screen.getByTestId('themed'));
    await user.click(screen.getByTestId('theme-toggle'));
    expect(box()).not.toBe(readLightMarkup('queryBoxDesktop'));
    await user.click(screen.getByTestId('theme-toggle'));
    expect(box()).toBe(readLightMarkup('queryBoxDesktop'));
  });

  it('toggling dark then back to light restores the exact stock header pill', async () => {
    const user = userEvent.setup();
    renderWithProviders(themed(headerElement()));
    const pill = () => headerPillMarkup(screen.getByTestId('themed'));
    await user.click(screen.getByTestId('theme-toggle'));
    expect(pill()).not.toBe(readLightMarkup('headerDesktop'));
    await user.click(screen.getByTestId('theme-toggle'));
    expect(pill()).toBe(readLightMarkup('headerDesktop'));
  });
});

describe('theme toggle', () => {
  it('defaults to light and leaves <html> untouched', () => {
    renderWithProviders(themed(null));
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-dark', 'false');
    expect(document.documentElement.className).toBe('');
  });

  it('toggle sets html.dark and persists the choice per user; toggling back removes it', async () => {
    const user = userEvent.setup();
    renderWithProviders(themed(null));

    await user.click(screen.getByTestId('theme-toggle'));
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-dark', 'true');
    expect(htmlIsDark()).toBe(true);
    expect(localStorage.getItem(roseThemeStorageKey(ROSE_THEME_USER))).toBe('dark');

    await user.click(screen.getByTestId('theme-toggle'));
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-dark', 'false');
    expect(htmlIsDark()).toBe(false);
    expect(localStorage.getItem(roseThemeStorageKey(ROSE_THEME_USER))).toBe('light');
  });

  it('restores the stored choice on mount and drops html.dark on unmount', () => {
    storeDark(ROSE_THEME_USER);
    const { unmount } = renderWithProviders(themed(null));
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-dark', 'true');
    expect(htmlIsDark()).toBe(true);
    unmount();
    expect(htmlIsDark()).toBe(false);
  });

  it('is per user: switching accounts re-reads that account and signing out goes light', () => {
    storeDark(ROSE_THEME_USER);
    const view = renderWithProviders(themed(null, ROSE_THEME_USER));
    expect(htmlIsDark()).toBe(true);

    view.rerender(themed(null, OTHER_USER));
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-dark', 'false');
    expect(htmlIsDark()).toBe(false);

    view.rerender(themed(null, ROSE_THEME_USER));
    expect(htmlIsDark()).toBe(true);

    view.rerender(themed(null, null));
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-dark', 'false');
    expect(htmlIsDark()).toBe(false);
  });

  it('is gated by the Rose Desktop flag: stock accounts never go dark', async () => {
    const user = userEvent.setup();
    storeDark(ROSE_THEME_USER);
    renderWithProviders(themed(backgroundElement()), { roseDesktop: false });
    await screen.findByTestId('terminal-small-tile-animation-canvas');
    expect(screen.getByTestId('theme-toggle')).toHaveAttribute('data-dark', 'false');
    expect(htmlIsDark()).toBe(false);

    await user.click(screen.getByTestId('theme-toggle'));
    expect(htmlIsDark()).toBe(false);
    expect(localStorage.getItem(roseThemeStorageKey(ROSE_THEME_USER))).toBe('dark');
    expect(themedMarkup()).toBe(readLightMarkup('backgroundDesktop'));
  });
});

describe('dark background', () => {
  beforeEach(() => storeDark(ROSE_THEME_USER));

  it('hides the small tile animation + dot canvas and drops the intro tile overlay', async () => {
    renderWithProviders(themed(backgroundElement()));
    await screen.findByTestId('terminal-small-tile-animation-canvas');
    expect(htmlIsDark()).toBe(true);
    const tiles = screen.getByTestId('terminal-small-tile-animation-canvas');
    expect(tiles).toHaveAttribute('hidden');
    expect(tiles).not.toBeVisible();
    tiles.querySelectorAll('canvas').forEach((canvas) => expect(canvas).not.toBeVisible());
    expect(gridLayer().querySelectorAll(':scope > rect[width="143"]')).toHaveLength(0);
  });

  it('draws grid lines, main tile border, sparkle circles and small diamonds in one neutral silver at one low opacity', () => {
    renderWithProviders(themed(backgroundElement()));
    const grid = gridLayer();

    // Never the bluish dark:*-gray-800 classes, never the light gray.
    expect(grid.querySelectorAll('[class*="gray-800"]')).toHaveLength(0);
    expect(grid.innerHTML).not.toContain('rgb(229, 231, 235)');

    const patternRect = grid.querySelector('#grid-pattern > rect');
    expect(patternRect).toHaveAttribute('stroke', SILVER);
    const patternPaths = grid.querySelectorAll('#grid-pattern > path');
    expect(patternPaths).toHaveLength(4);
    patternPaths.forEach((p) => expect(p).toHaveAttribute('fill', SILVER));

    const gridFill = grid.querySelector(':scope > rect[fill="url(#grid-pattern)"]');
    const border = grid.querySelector(':scope > rect[width="429"]');
    const circles = grid.querySelectorAll(':scope > circle');
    const smallDiamonds = grid.querySelectorAll(`:scope > path[fill="${SILVER}"]`);
    expect(circles).toHaveLength(2);
    expect(smallDiamonds).toHaveLength(2);
    expect(border).toHaveAttribute('stroke', SILVER);
    circles.forEach((c) => expect(c).toHaveAttribute('stroke', SILVER));

    const opacities = [gridFill, border, ...circles, ...smallDiamonds].map((el) =>
      el?.getAttribute('opacity'),
    );
    expect(new Set(opacities)).toEqual(new Set(['0.14']));

    // The rose-gradient sparkle diamonds keep their gradient.
    expect(grid.querySelectorAll(':scope > path[fill="url(#rose-gradient)"]')).toHaveLength(2);
  });

  it('dims the energy pill streaks', () => {
    renderWithProviders(themed(backgroundElement()));
    const flow = screen
      .getByTestId('terminal-grid-energy-layer')
      .querySelector('g.grid-energy-pill-flow');
    expect(flow).toHaveAttribute('opacity', '0.14');
    expect(flow).toHaveAttribute('mask', 'url(#terminal-energy-large-tile-mask)');
  });

  it('dims the mobile energy pills only when an opacity is given', () => {
    setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);

    const stock = render(
      <MobileGridEnergyPills patternOffset={{ x: 0, y: 0 }} selectedAgentId={null} />,
    );
    expect(mobileEnergyPills()).toHaveLength(8);
    expect(mobilePillPaint()).toEqual(pillPaint(LIGHT_PILL_STOPS, ''));
    stock.unmount();

    render(
      <MobileGridEnergyPills
        patternOffset={{ x: 0, y: 0 }}
        selectedAgentId={null}
        opacity={0.14}
      />,
    );
    expect(mobileEnergyPills()).toHaveLength(8);
    expect(mobilePillPaint()).toEqual(pillPaint(LIGHT_PILL_STOPS, '0.14'));
  });

  it('turns the desktop header pill dark with light text and hides the marble layer', () => {
    renderWithProviders(themed(headerElement()));
    const header = screen.getByTestId('themed').querySelector('header');
    expect(header).toHaveClass(
      'dark:!bg-[rgba(32,32,30,0.78)]',
      'dark:!border-white/[0.08]',
      'dark:!shadow-[0_6px_20px_rgba(0,0,0,0.35)]',
      'dark:text-[#ececea]',
    );
    expect(header?.firstElementChild).toHaveClass('dark:hidden');
  });
});

describe('dark query box (mock panels/dark.js; FE-13 visual pass)', () => {
  const surface = () => screen.getByTestId('query-input-surface');
  const modelChip = () => screen.getByText('rose-flash').closest('button')!;

  it('is the solid #2f2f2c surface with a 9% white border, deep shadow and no white marble', () => {
    storeDark(ROSE_THEME_USER);
    renderWithProviders(themed(queryBoxElement()));
    expect(htmlIsDark()).toBe(true);
    const box = surface();
    expect(box.style.backgroundColor).toBe('rgb(47, 47, 44)');
    // Outer borders stay subtle in dark (<= white .10).
    expect(box.style.borderColor).toBe('rgba(255, 255, 255, 0.09)');
    expect(box.style.boxShadow).toBe('0 10px 40px rgba(0, 0, 0, 0.35)');
    expect(box.getAttribute('style')).not.toContain('backdrop-filter');
    // No translucent white drip or marble layer: the content wrapper is the only child.
    expect(box.children).toHaveLength(1);
    expect(box.firstElementChild).toHaveClass('relative', 'z-10');
    expect(box.outerHTML).not.toMatch(/radial-gradient|rgba\(255, 255, 255, 0\.6\)/);
  });

  it('textarea reads #f2f2ef with a #8c8c86 placeholder; light keeps the theme classes', () => {
    storeDark(ROSE_THEME_USER);
    renderWithProviders(themed(queryBoxElement()));
    const textarea = within(surface()).getByRole('textbox');
    expect(textarea).toHaveClass(
      'text-foreground',
      'placeholder:text-muted-foreground',
      'dark:text-[#f2f2ef]',
      'dark:placeholder:text-[#8c8c86]',
    );
  });

  it('model chip is #2f2f2c with a 9% white border and #e4e4df text, same shape; light unchanged', () => {
    renderWithProviders(themed(queryBoxElement()));
    const light = modelChip().className;
    expect(light).toContain('dark:bg-gray-800');
    expect(light).not.toMatch(/#2f2f2c|#e4e4df/);
    act(() => screen.getByTestId('theme-toggle').click());
    const dark = modelChip();
    expect(dark).toHaveClass(
      'dark:bg-[#2f2f2c]',
      'dark:border-white/[0.09]',
      'dark:text-[#e4e4df]',
      // Same shape and light colors as the stock chip.
      'rounded-lg',
      'px-2',
      'py-1',
      'text-xs',
      'border',
      'border-gray-300',
      'bg-gray-100',
      'text-gray-700',
    );
    expect(dark.className).not.toMatch(/dark:(bg-gray-800|border-gray-700|text-gray-300)/);
  });

  it('the Rose toolset and World Simulator chips keep their exact light styling', () => {
    renderWithProviders(themed(queryBoxElement()));
    const lightTools = screen.getByTestId('query-pinned-tools').outerHTML;
    act(() => screen.getByTestId('theme-toggle').click());
    expect(htmlIsDark()).toBe(true);
    expect(screen.getByTestId('query-pinned-tools').outerHTML).toBe(lightTools);
  });

  it('switches in the commit that flips html.dark, both ways', () => {
    renderWithProviders(themed(queryBoxElement()));
    toggleThemeInOneCommit();
    expect(surface().style.backgroundColor).toBe('rgb(47, 47, 44)');
    toggleThemeInOneCommit();
    expect(surface().style.backgroundColor).toBe('rgba(255, 255, 255, 0.6)');
    expect(queryBoxMarkup(screen.getByTestId('themed'))).toBe(readLightMarkup('queryBoxDesktop'));
  });

  it('a stock account with a stored dark choice keeps the stock translucent box', () => {
    storeDark(ROSE_THEME_USER);
    renderWithProviders(themed(queryBoxElement()), { roseDesktop: false });
    expect(htmlIsDark()).toBe(false);
    expect(surface().style.backgroundColor).toBe('rgba(255, 255, 255, 0.6)');
    expect(surface().outerHTML).not.toMatch(/#2f2f2c|#f2f2ef|#8c8c86|#e4e4df|47, 47, 44/);
  });
});

describe('dark Popular Goals pills (mock button[class*="border"])', () => {
  const row = () => screen.getByTestId('popular-goals-row');
  const pills = () => within(screen.getByTestId('popular-goals-track')).getAllByRole('button');

  it('light control: the flagged row renders the stock markup byte-for-byte', () => {
    renderWithProviders(themed(popularGoalsElement()));
    expect(`${row().outerHTML}\n`).toBe(readLightMarkup('popularGoalsDesktop'));
  });

  it('dark: #2f2f2c fill, 9% white border, #e4e4df text, same pill shape; label #a3a39d', () => {
    storeDark(ROSE_THEME_USER);
    renderWithProviders(themed(popularGoalsElement()));
    expect(htmlIsDark()).toBe(true);
    for (const pill of pills()) {
      expect(pill).toHaveClass(
        'dark:bg-[#2f2f2c]',
        'dark:text-[#e4e4df]',
        'dark:hover:bg-[#383835]',
        'px-3',
        'py-1',
        'text-xs',
        'rounded-full',
        'border',
      );
      // The inline drip border (whitish) is replaced, not layered under a class.
      expect(pill.style.borderColor).toBe('rgba(255, 255, 255, 0.09)');
    }
    expect(within(row()).getByText('Popular Goals')).toHaveClass('dark:text-[#a3a39d]');
  });

  it('switches back to the exact stock row in the commit that leaves dark', () => {
    storeDark(ROSE_THEME_USER);
    renderWithProviders(themed(popularGoalsElement()));
    toggleThemeInOneCommit();
    expect(`${row().outerHTML}\n`).toBe(readLightMarkup('popularGoalsDesktop'));
  });
});

describe('instant theme switch (row 72)', () => {
  it('every desktop layer switches in the commit that flips html.dark, both ways', async () => {
    renderWithProviders(themed(backgroundElement()));
    await screen.findByTestId('terminal-small-tile-animation-canvas');
    const tiles = () => screen.getByTestId('terminal-small-tile-animation-canvas');
    const flow = () =>
      screen.getByTestId('terminal-grid-energy-layer').querySelector('g.grid-energy-pill-flow');
    expect(tiles()).toBeVisible();

    toggleThemeInOneCommit();
    expect(htmlIsDark()).toBe(true);
    expect(tiles()).not.toBeVisible();
    expect(gridLayer().querySelector('#grid-pattern > rect')).toHaveAttribute('stroke', SILVER);
    expect(flow()).toHaveAttribute('opacity', '0.14');

    toggleThemeInOneCommit();
    expect(htmlIsDark()).toBe(false);
    expect(tiles()).toBeVisible();
    expect(themedMarkup()).toBe(readLightMarkup('backgroundDesktop'));
  });

  it('the header pill switches in the same commit', () => {
    renderWithProviders(themed(headerElement()));
    toggleThemeInOneCommit();
    expect(screen.getByTestId('themed').querySelector('header')).toHaveClass(
      'dark:!bg-[rgba(32,32,30,0.78)]',
    );
    toggleThemeInOneCommit();
    expect(headerPillMarkup(screen.getByTestId('themed'))).toBe(readLightMarkup('headerDesktop'));
  });

  it('the tile dot canvas draws nothing in dark and repaints its light dots in the commit that leaves dark', async () => {
    const canvas = installFakeCanvas();
    const fillsAtLayout: Array<{ isDark: boolean; fills: string[] }> = [];
    const onLayout = (isDark: boolean) => {
      fillsAtLayout.push({ isDark, fills: [...canvas.fillStyleAtFill] });
    };
    renderWithProviders(themed(withLayoutPhaseProbe(backgroundElement(), onLayout)));
    await screen.findByTestId('terminal-small-tile-animation-canvas');
    expect(new Set(canvas.fillStyleAtFill)).toEqual(new Set([LIGHT_DOT]));

    canvas.fillStyleAtFill.length = 0;
    canvas.clearRect.mockClear();
    toggleThemeInOneCommit();
    expect(screen.getByTestId('terminal-small-tile-animation-canvas')).not.toBeVisible();
    expect(canvas.clearRect).toHaveBeenCalled();
    expect(canvas.fillStyleAtFill).toEqual([]);

    fillsAtLayout.length = 0;
    toggleThemeInOneCommit();
    expect(canvas.framesRun()).toBe(0);
    expect(screen.getByTestId('terminal-small-tile-animation-canvas')).toBeVisible();
    // Already repainted in the layout phase of the commit that removed html.dark
    // (not by a later passive effect or animation frame), in the light colour only.
    expect(fillsAtLayout).toHaveLength(1);
    expect(fillsAtLayout[0].isDark).toBe(false);
    expect(fillsAtLayout[0].fills.length).toBeGreaterThan(0);
    expect(new Set(fillsAtLayout[0].fills)).toEqual(new Set([LIGHT_DOT]));
    expect(new Set(canvas.fillStyleAtFill)).toEqual(new Set([LIGHT_DOT]));
  });

  it('the mobile energy pills restyle in the commit that flips html.dark, with no animation frame', () => {
    setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
    const animationFrame = vi.spyOn(window, 'requestAnimationFrame');
    renderWithProviders(themed(backgroundElement()));
    expect(mobilePillPaint()).toEqual(pillPaint(LIGHT_PILL_STOPS, ''));

    toggleThemeInOneCommit();
    expect(htmlIsDark()).toBe(true);
    // Dimmed and switched to the dark gradient stops by the commit itself.
    expect(mobilePillPaint()).toEqual(pillPaint(DARK_PILL_STOPS, '0.14'));

    toggleThemeInOneCommit();
    expect(htmlIsDark()).toBe(false);
    expect(mobilePillPaint()).toEqual(pillPaint(LIGHT_PILL_STOPS, ''));
    expect(animationFrame).not.toHaveBeenCalled();
  });
});

describe('completed agent check (row 71)', () => {
  const done: AgentRunStatus = { state: 'done', label: 'Completed' };
  /** lucide's own classes + the stock DoneGlyph classes, unchanged since before dark mode. */
  const STOCK_CHECK_CLASSES = 'lucide lucide-check h-3 w-3 text-gray-400';

  function checkClasses() {
    return screen
      .getByRole('img', { name: 'Completed' })
      .querySelector('svg')
      ?.getAttribute('class');
  }

  it('light (stock or Rose light) renders the stock gray check byte-for-byte', () => {
    const stock = render(<AgentStatusIndicator status={done} />);
    expect(checkClasses()).toBe(STOCK_CHECK_CLASSES);
    stock.unmount();

    renderWithProviders(themed(<AgentStatusIndicator status={done} />));
    expect(htmlIsDark()).toBe(false);
    expect(checkClasses()).toBe(STOCK_CHECK_CLASSES);
  });

  it('is green (#22c55e) under html.dark and back to the stock check in the commit that leaves dark', () => {
    storeDark(ROSE_THEME_USER);
    renderWithProviders(themed(<AgentStatusIndicator status={done} />));
    expect(htmlIsDark()).toBe(true);
    // A dark: variant only (scoped to html.dark), never an unconditional green class.
    expect(checkClasses()).toBe(`${STOCK_CHECK_CLASSES} dark:text-[#22c55e]`);

    toggleThemeInOneCommit();
    expect(htmlIsDark()).toBe(false);
    expect(checkClasses()).toBe(STOCK_CHECK_CLASSES);
  });

  it('a failed run keeps its muted red x in both themes', () => {
    const { container } = render(<AgentStatusIndicator status={{ ...done, failed: true }} />);
    expect(container.querySelector('svg')?.getAttribute('class')).not.toContain('22c55e');
  });
});

describe('terminal wiring', () => {
  function mockSession(userId: string) {
    const session = {
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: userId, is_anonymous: false },
    };
    localStorage.setItem('rose-session', JSON.stringify(session));
    localStorage.setItem('app-user', JSON.stringify({ id: userId, is_anonymous: false }));
  }

  it('a Rose Desktop account with a stored dark choice gets html.dark and the calm background', async () => {
    mockSession(ROSE_THEME_USER);
    storeDark(ROSE_THEME_USER);
    renderWithProviders(<Terminal />);
    await screen.findByTestId('rose-app-icons');
    await waitFor(() => expect(htmlIsDark()).toBe(true));
    expect(await screen.findByTestId('terminal-small-tile-animation-canvas')).not.toBeVisible();
  });

  it('login enters dark mode and the top-right icon still toggles both ways', async () => {
    const user = userEvent.setup();
    mockSession(ROSE_THEME_USER);
    renderWithProviders(<Terminal />);
    const icon = await screen.findByTestId('rose-app-dark-mode');
    await waitFor(() => expect(htmlIsDark()).toBe(true));
    expect(localStorage.getItem(`rose-theme:${ROSE_THEME_USER}`)).toBe('dark');
    expect(icon).toHaveAttribute('aria-label', 'Light mode');
    await user.click(icon);
    await waitFor(() => expect(htmlIsDark()).toBe(false));
    expect(localStorage.getItem(`rose-theme:${ROSE_THEME_USER}`)).toBe('light');
    await user.click(screen.getByTestId('rose-app-dark-mode'));
    await waitFor(() => expect(htmlIsDark()).toBe(true));
    expect(localStorage.getItem(`rose-theme:${ROSE_THEME_USER}`)).toBe('dark');
  });

  it('an ordinary signed-in account restores its own dark choice', async () => {
    mockSession(OTHER_USER);
    storeDark(OTHER_USER);
    renderWithProviders(<Terminal />);
    await screen.findByTestId('rose-app-icons');
    await waitFor(() => expect(htmlIsDark()).toBe(true));
    expect(await screen.findByTestId('terminal-small-tile-animation-canvas')).not.toBeVisible();
  });
});
