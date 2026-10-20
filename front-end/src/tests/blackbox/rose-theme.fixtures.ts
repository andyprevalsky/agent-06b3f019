/**
 * Shared fixtures for the Rose dark-mode blackbox (rose-theme.blackbox.tsx).
 *
 * LIGHT_MARKUP_FIXTURES were captured from the stock components at
 * feat/rose-user-ui dccc2f63c, BEFORE any dark-mode code existed. Andy's hard
 * rule: dark-mode work must never change light mode in any way, so light mode
 * must keep rendering these exact bytes.
 *
 * Plain .ts (createElement, no JSX) so the module exports helpers, not components.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Fragment, createElement, useLayoutEffect, type ReactNode } from 'react';

import { BackgroundPattern } from '@/features/terminal/components/BackgroundPattern';
import { TerminalHeader } from '@/features/terminal/components/TerminalHeader';
import type { DripStyles } from '@/features/terminal/types';
import { RoseThemeProvider, useRoseTheme } from '@/features/rose-theme';

export const ROSE_THEME_USER = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

export const LIGHT_MARKUP_DIR = path.resolve(__dirname, 'fixtures/rose-theme-light');

export const LIGHT_MARKUP_FIXTURES = {
  backgroundDesktop: 'background-desktop.html',
  backgroundMobile: 'background-mobile.html',
  headerDesktop: 'header-desktop.html',
} as const;

export type LightMarkupFixture = keyof typeof LIGHT_MARKUP_FIXTURES;

export function readLightMarkup(name: LightMarkupFixture): string {
  return fs.readFileSync(path.join(LIGHT_MARKUP_DIR, LIGHT_MARKUP_FIXTURES[name]), 'utf-8');
}

export function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

export const DESKTOP_VIEWPORT = { width: 1440, height: 900 } as const;
export const MOBILE_VIEWPORT = { width: 390, height: 844 } as const;

/** One intro-animation tile is coloured so the animated tile overlay renders a rect. */
const TILE_COLORS = new Map<string, number>([
  ['0,0', 1],
  ['1,2', 0],
]);
const COLOR_PALETTE = [{ hex: '#ffffff' }, { hex: '#FD5776' }];

export function backgroundElement() {
  return createElement(BackgroundPattern, {
    patternOffset: { x: 12, y: -7 },
    tileColors: TILE_COLORS,
    colorPalette: COLOR_PALETTE,
    animationResetKey: 0,
    animationComplete: true,
    currentFrame: 0,
    selectedAgentId: null,
  });
}

const DRIP_STYLES: DripStyles = {
  blur: 12,
  bgOpacity: 0.6,
  borderOpacity: 0.4,
  shadowIntensity: 0.12,
  glow: 8,
  glowOpacity: 0.1,
  saturation: 1.4,
  brightness: 1.05,
  backgroundColorsScalar: 0.5,
  borderColorScalar: 0.5,
  borderRgb: 'rgba(255, 255, 255, 0.4)',
};

const noop = () => {};

export function headerElement() {
  return createElement(TerminalHeader, {
    onCreateNewAgent: noop,
    onSelectAgent: noop,
    onLoginClick: noop,
    onLogout: noop,
    isSignedIn: true,
    clientSource: 'WEB',
    agents: [],
    isLoadingAgents: false,
    selectedAgentId: null,
    onRefreshAgents: noop,
    dripStyles: DRIP_STYLES,
    blur: 10,
    backgroundColors: 10,
    borderColor: 10,
    shadowIntensity: 10,
  });
}

/** The desktop header pill: the header element (shallow) plus its marble layer. */
export function headerPillMarkup(container: HTMLElement): string {
  const header = container.querySelector('header');
  if (header === null) throw new Error('header not rendered');
  const shallow = header.cloneNode(false) as HTMLElement;
  const marble = header.firstElementChild as HTMLElement;
  return `${shallow.outerHTML}\n${marble.outerHTML}\n`;
}

/** Stand-in for the right-bar dark mode button: reads and flips useRoseTheme(). */
function ThemeToggle() {
  const { isDark, toggle } = useRoseTheme();
  return createElement(
    'button',
    { type: 'button', 'data-testid': 'theme-toggle', 'data-dark': String(isDark), onClick: toggle },
    'toggle',
  );
}

/** `ui` under a RoseThemeProvider for `userId`, plus the toggle; `ui` sits in [data-testid=themed]. */
export function themed(ui: ReactNode, userId: string | null = ROSE_THEME_USER) {
  const children = createElement(
    Fragment,
    null,
    createElement(ThemeToggle),
    createElement('div', { 'data-testid': 'themed' }, ui),
  );
  return createElement(RoseThemeProvider, { userId, children });
}

/**
 * Calls onLayout from its own layout effect whenever the theme flips. Rendered
 * after `ui`, so it runs once every layout effect of `ui` in that commit has run
 * and before any passive effect: what the canvases hold then is what the frame
 * that flips html.dark paints.
 */
function LayoutPhaseProbe({ onLayout }: { onLayout: (isDark: boolean) => void }) {
  const { isDark } = useRoseTheme();
  useLayoutEffect(() => {
    onLayout(isDark);
  }, [isDark, onLayout]);
  return null;
}

/** `ui` followed by a LayoutPhaseProbe reporting to onLayout. */
export function withLayoutPhaseProbe(ui: ReactNode, onLayout: (isDark: boolean) => void) {
  return createElement(Fragment, null, ui, createElement(LayoutPhaseProbe, { onLayout }));
}
