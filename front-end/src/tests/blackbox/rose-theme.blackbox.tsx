/**
 * Rose Desktop dark mode (UI ledger rows 25/52/62): useRoseTheme() toggles
 * light <-> dark per user, dark adds html.dark and the calm dark background,
 * and light mode stays byte-identical to the stock UI.
 */
import fs from 'node:fs';
import path from 'node:path';
import postcss, { type Rule } from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { flushSync } from 'react-dom';

import AgentStatusIndicator from '@/features/terminal-component-group/components/AgentStatusIndicator';
import type { AgentRunStatus } from '@/features/terminal-component-group/components/agentRunState';
import { MobileGridEnergyPillsCanvas } from '@/features/terminal/components/GridEnergyPills';
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
  readLightMarkup,
  setViewport,
  themed,
  withLayoutPhaseProbe,
} from './rose-theme.fixtures';

const OTHER_USER = '8283e892-b0a4-4298-9ef7-b95bcc67e46b';
const SILVER = '#d6d6d2';
/** SmallTileAnimationCanvas dot colours (renderTiles resolveDotColor). */
const LIGHT_DOT = 'rgba(229, 231, 235, 0.8)';
/** Mobile energy canvas core gradient stop: html.dark → 1, light → 0.95. */
const DARK_CORE_STOP = 'rgba(255, 255, 255, 1)';
const LIGHT_CORE_STOP = 'rgba(255, 255, 255, 0.95)';

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
  document.documentElement.classList.remove('dark');
  localStorage.clear();
  vi.restoreAllMocks();
  setViewport(DESKTOP_VIEWPORT.width, DESKTOP_VIEWPORT.height);
});

describe('light mode is unchanged (markup frozen before dark mode existed)', () => {
  it('desktop background renders the stock markup byte-for-byte', () => {
    renderWithProviders(themed(backgroundElement()));
    expect(themedMarkup()).toBe(readLightMarkup('backgroundDesktop'));
    expect(htmlIsDark()).toBe(false);
  });

  it('mobile background renders the stock markup byte-for-byte', () => {
    setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
    renderWithProviders(themed(backgroundElement()));
    expect(themedMarkup()).toBe(readLightMarkup('backgroundMobile'));
  });

  it('desktop header pill keeps the stock classes and inline drip styles', () => {
    renderWithProviders(themed(headerElement()));
    expect(headerPillMarkup(screen.getByTestId('themed'))).toBe(readLightMarkup('headerDesktop'));
  });

  it('without a theme provider (shared/benchmark views) everything is stock', () => {
    const { container } = renderWithProviders(backgroundElement());
    expect(`${container.innerHTML}\n`).toBe(readLightMarkup('backgroundDesktop'));
  });

  it('toggling dark then back to light restores the exact stock markup', async () => {
    const user = userEvent.setup();
    renderWithProviders(themed(backgroundElement()));
    await user.click(screen.getByTestId('theme-toggle'));
    expect(themedMarkup()).not.toBe(readLightMarkup('backgroundDesktop'));
    await user.click(screen.getByTestId('theme-toggle'));
    expect(themedMarkup()).toBe(readLightMarkup('backgroundDesktop'));
    expect(htmlIsDark()).toBe(false);
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

  it('hides the small tile animation + dot canvas and drops the intro tile overlay', () => {
    renderWithProviders(themed(backgroundElement()));
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
    expect(flow).toHaveAttribute('opacity', '0.28');
    expect(flow).toHaveAttribute('mask', 'url(#terminal-energy-large-tile-mask)');
  });

  it('dims the mobile canvas energy pills only when an opacity is given', () => {
    setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
    const canvas = installFakeCanvas();

    const stock = render(
      <MobileGridEnergyPillsCanvas patternOffset={{ x: 0, y: 0 }} selectedAgentId={null} />,
    );
    act(() => canvas.runFrame(1000));
    expect(canvas.alphaWrites()).toBe(0);
    expect(new Set(canvas.alphaAtFill)).toEqual(new Set([1]));
    stock.unmount();

    canvas.alphaAtFill.length = 0;
    render(
      <MobileGridEnergyPillsCanvas
        patternOffset={{ x: 0, y: 0 }}
        selectedAgentId={null}
        opacity={0.28}
      />,
    );
    act(() => canvas.runFrame(1000));
    expect(canvas.alphaAtFill.length).toBeGreaterThan(0);
    expect(new Set(canvas.alphaAtFill)).toEqual(new Set([0.28]));
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

describe('instant theme switch (row 72)', () => {
  it('every desktop layer switches in the commit that flips html.dark, both ways', () => {
    renderWithProviders(themed(backgroundElement()));
    const tiles = () => screen.getByTestId('terminal-small-tile-animation-canvas');
    const flow = () =>
      screen.getByTestId('terminal-grid-energy-layer').querySelector('g.grid-energy-pill-flow');
    expect(tiles()).toBeVisible();

    toggleThemeInOneCommit();
    expect(htmlIsDark()).toBe(true);
    expect(tiles()).not.toBeVisible();
    expect(gridLayer().querySelector('#grid-pattern > rect')).toHaveAttribute('stroke', SILVER);
    expect(flow()).toHaveAttribute('opacity', '0.28');

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

  it('the tile dot canvas draws nothing in dark and repaints its light dots in the commit that leaves dark', () => {
    const canvas = installFakeCanvas();
    const fillsAtLayout: Array<{ isDark: boolean; fills: string[] }> = [];
    const onLayout = (isDark: boolean) => {
      fillsAtLayout.push({ isDark, fills: [...canvas.fillStyleAtFill] });
    };
    renderWithProviders(themed(withLayoutPhaseProbe(backgroundElement(), onLayout)));
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

  it('the mobile energy canvas repaints synchronously, not on its next animation frame', () => {
    setViewport(MOBILE_VIEWPORT.width, MOBILE_VIEWPORT.height);
    const canvas = installFakeCanvas();
    renderWithProviders(themed(backgroundElement()));
    expect(canvas.alphaAtFill).toHaveLength(0);

    toggleThemeInOneCommit();
    expect(canvas.framesRun()).toBe(0);
    expect(canvas.alphaAtFill.length).toBeGreaterThan(0);
    expect(new Set(canvas.alphaAtFill)).toEqual(new Set([0.28]));
    // Painted after html.dark flipped: the dark gradient stops are used.
    expect(canvas.gradient.addColorStop).toHaveBeenCalledWith(0.52, DARK_CORE_STOP);
    expect(canvas.gradient.addColorStop).not.toHaveBeenCalledWith(0.52, LIGHT_CORE_STOP);

    canvas.alphaAtFill.length = 0;
    canvas.gradient.addColorStop.mockClear();
    toggleThemeInOneCommit();
    expect(canvas.framesRun()).toBe(0);
    expect(new Set(canvas.alphaAtFill)).toEqual(new Set([1]));
    expect(canvas.gradient.addColorStop).toHaveBeenCalledWith(0.52, LIGHT_CORE_STOP);
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

describe('dark scrollbars (row 62)', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../../index.css'), 'utf-8');
  const root = postcss.parse(css);
  const scrollbarRules: Rule[] = [];
  root.walkRules((rule) => {
    const touchesScrollbars =
      rule.selector.includes('::-webkit-scrollbar') ||
      rule.some(
        (node) =>
          node.type === 'decl' && (node.prop === 'color-scheme' || node.prop === 'scrollbar-color'),
      );
    // The code-agent terminal keeps its own green scrollbar in both themes.
    if (touchesScrollbars && !rule.selector.includes('.code-agent-terminal-host')) {
      scrollbarRules.push(rule);
    }
  });

  function decls(selector: string): Record<string, string> {
    const rule = scrollbarRules.find((r) => r.selectors.includes(selector));
    if (rule === undefined) throw new Error(`missing rule ${selector}`);
    const out: Record<string, string> = {};
    rule.walkDecls((d) => {
      out[d.prop] = d.value;
    });
    return out;
  }

  it('scopes every scrollbar / color-scheme rule under html.dark (light untouched)', () => {
    expect(scrollbarRules.length).toBeGreaterThanOrEqual(6);
    for (const rule of scrollbarRules) {
      for (const selector of rule.selectors) {
        expect(selector).toMatch(/^html\.dark(\s|$)/);
      }
    }
  });

  it('uses dark native controls and the navi scrollbar colours', () => {
    expect(decls('html.dark')['color-scheme']).toBe('dark');
    expect(decls('html.dark *')['scrollbar-color']).toBe('#4a4a46 transparent');
    expect(decls('html.dark ::-webkit-scrollbar-thumb')).toMatchObject({
      background: '#4a4a46',
      'border-radius': '10px',
      border: '2px solid #272725',
    });
    expect(decls('html.dark ::-webkit-scrollbar-thumb:hover').background).toBe('#5c5c57');
    expect(decls('html.dark ::-webkit-scrollbar-track').background).toBe('transparent');
    expect(decls('html.dark ::-webkit-scrollbar-corner').background).toBe('transparent');
    expect(decls('html.dark ::-webkit-scrollbar').background).toBe('transparent');
  });

  it('keeps the webkit hover thumb in Chromium: scrollbar-color only where ::-webkit-scrollbar is unsupported', () => {
    // Chromium ignores every ::-webkit-scrollbar rule on an element with a
    // non-auto scrollbar-color, which would drop the #5c5c57 hover thumb.
    const colorRules = scrollbarRules.filter((rule) =>
      rule.some((node) => node.type === 'decl' && node.prop === 'scrollbar-color'),
    );
    expect(colorRules.length).toBeGreaterThan(0);
    for (const rule of colorRules) {
      const parent = rule.parent;
      expect(parent?.type).toBe('atrule');
      expect(parent?.type === 'atrule' && `@${parent.name} ${parent.params}`).toBe(
        '@supports not selector(::-webkit-scrollbar)',
      );
    }
  });

  it('paints the page solid navi black, scoped to html.dark', () => {
    const pageRules: Rule[] = [];
    root.walkRules((rule) => {
      if (rule.selectors.includes('html.dark body')) pageRules.push(rule);
    });
    expect(pageRules).toHaveLength(1);
    const [page] = pageRules;
    page.selectors.forEach((selector) => expect(selector).toMatch(/^html\.dark(\s|$)/));
    const background: string[] = [];
    page.walkDecls('background-color', (d) => {
      background.push(d.value);
    });
    expect(background).toEqual(['#272725']);
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
    expect(screen.getByTestId('terminal-small-tile-animation-canvas')).not.toBeVisible();
  });

  it("the top-right Dark mode icon drives the terminal's RoseThemeProvider", async () => {
    const user = userEvent.setup();
    mockSession(ROSE_THEME_USER);
    renderWithProviders(<Terminal />);
    const icon = await screen.findByTestId('rose-app-dark-mode');
    expect(htmlIsDark()).toBe(false);
    await user.click(icon);
    await waitFor(() => expect(htmlIsDark()).toBe(true));
    expect(localStorage.getItem(`rose-theme:${ROSE_THEME_USER}`)).toBe('dark');
    expect(screen.getByTestId('rose-app-dark-mode')).toHaveAttribute('aria-label', 'Light mode');
    await user.click(screen.getByTestId('rose-app-dark-mode'));
    await waitFor(() => expect(htmlIsDark()).toBe(false));
    expect(localStorage.getItem(`rose-theme:${ROSE_THEME_USER}`)).toBe('light');
  });

  it('a stock account with the same stored key stays light with the stock background', async () => {
    mockSession(OTHER_USER);
    storeDark(OTHER_USER);
    renderWithProviders(<Terminal />);
    expect(await screen.findByTestId('terminal-small-tile-animation-canvas')).toBeVisible();
    expect(screen.queryByTestId('rose-app-icons')).not.toBeInTheDocument();
    expect(htmlIsDark()).toBe(false);
  });
});
