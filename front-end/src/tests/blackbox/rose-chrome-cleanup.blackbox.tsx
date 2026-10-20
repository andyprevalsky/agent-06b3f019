/**
 * Blackbox tests for rose-user-ui "Chrome cleanup" + mobile query box
 * (UI ledger #11, #14, #15):
 *  - the mobile query box hugs the iPhone bottom display curve (safe-area
 *    padding, concentric bottom radius, viewport-fit=cover)
 *  - Research / Careers are gone from the desktop nav and the mobile header
 *  - the nub toolbar ENDS with a bare info icon; its menu has About/Privacy/Terms
 *  - the pinned "Import Code Repo" goal stays first while the ticker moves
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import Terminal from '@/pages/Terminal';
import QueryInput from '@/features/terminal-component-group/components/QueryInput';
import { PopularGoalsCarousel } from '@/features/terminal/components/PopularGoalsCarousel';
import { PINNED_IMPORT_REPO_GOAL } from '@/features/terminal/config';
import type { DripStyles } from '@/features/terminal/types';

const API_BASE = 'http://localhost:3001/api';
const FRONT_END = process.cwd();

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

beforeEach(() => {
  mockSession();
  server.use(
    http.get(`${API_BASE}/user/profile`, () => HttpResponse.json({ name: 'Test User' })),
    http.get(`${API_BASE}/user/subscription`, () => HttpResponse.json({ tier: 10 })),
    http.get(`${API_BASE}/user/customization`, () =>
      HttpResponse.json({ systemPrompt: '', contextGates: {} }),
    ),
    http.get(`${API_BASE}/credits/stats`, () =>
      HttpResponse.json({ totalTokens: 0, topModels: [] }),
    ),
  );
});

afterEach(() => {
  setViewport(1024, 768);
  localStorage.clear();
});

// ─── Mobile query box hugs the display curve ────────────────────────────────

describe('mobile query box safe area', () => {
  const css = readFileSync(resolve(FRONT_END, 'src/index.css'), 'utf8');

  function mobileRule(): string {
    const media = css.indexOf('@media (max-width: 767px) {\n  .rose-mobile-querybox');
    expect(media).toBeGreaterThan(-1);
    return css.slice(media, css.indexOf('\n}\n', media));
  }

  it('opts the page into the full display (viewport-fit=cover)', () => {
    const html = readFileSync(resolve(FRONT_END, 'index.html'), 'utf8');
    expect(html).toMatch(/name="viewport"[\s\S]*?content="[^"]*viewport-fit=cover/);
  });

  it('defines the display corner and the gap equal to the column side inset', () => {
    expect(css).toMatch(/--display-corner:\s*55px;/);
    // MainContent pads the chat column px-2 (0.5rem) on mobile; the bottom gap matches.
    expect(css).toMatch(/--mobile-querybox-gap:\s*0\.5rem;/);
    expect(css).toMatch(/--safe-area-inset-bottom:\s*env\(safe-area-inset-bottom, 0px\);/);
  });

  it('matches the bottom corners to the display curve minus the gap', () => {
    const rule = mobileRule();
    expect(rule).toMatch(
      /--mobile-querybox-radius:\s*min\(\s*calc\(var\(--display-corner\) - var\(--mobile-querybox-gap\)\),\s*calc\(var\(--radius\) \+ var\(--safe-area-inset-bottom\) \* 2\)\s*\)/,
    );
    expect(rule).toMatch(/border-bottom-left-radius:\s*var\(--mobile-querybox-radius\)/);
    expect(rule).toMatch(/border-bottom-right-radius:\s*var\(--mobile-querybox-radius\)/);
  });

  it('pads the inside of the box by the rest of the bottom safe-area inset', () => {
    expect(mobileRule()).toMatch(
      /padding-bottom:\s*calc\(\s*0\.75rem \+ max\(0px, var\(--safe-area-inset-bottom\) - var\(--mobile-querybox-gap\)\)\s*\)/,
    );
  });

  it('applies the hug class to the query box and only a one-gap pad below it', async () => {
    setViewport(390, 844);
    renderWithProviders(<Terminal />);
    const inputArea = await screen.findByTestId('terminal-input-area');
    expect(inputArea).toHaveClass('pb-[var(--mobile-querybox-gap)]');
    expect(inputArea.className).not.toMatch(/safe-area-inset-bottom/);
    expect(within(inputArea).getByTestId('query-input-surface')).toHaveClass(
      'rose-mobile-querybox',
      'rounded-xl',
    );
    // Nothing (e.g. the old legal footer) sits between the box and the screen edge.
    expect(screen.queryByTestId('terminal-legal-links')).not.toBeInTheDocument();
  });
});

// ─── Research / Careers removed ─────────────────────────────────────────────

describe('top nav chrome', () => {
  it.each([
    ['desktop', 1280, 800],
    ['390px mobile', 390, 844],
  ])('renders no Research or Careers link on %s', async (_label, width, height) => {
    setViewport(width, height);
    renderWithProviders(<Terminal />);
    await screen.findByPlaceholderText('Enter any goal');
    for (const name of ['Research', 'Careers']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('banner')).not.toHaveTextContent(/Research|Careers/);
  });

  it('keeps the desktop Download link', async () => {
    setViewport(1280, 800);
    renderWithProviders(<Terminal />);
    expect(await screen.findByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/download',
    );
  });
});

// ─── Info icon at the end of the nub toolbar ────────────────────────────────

describe('nub toolbar info menu', () => {
  function renderQueryInput() {
    renderWithProviders(
      <QueryInput
        value=""
        onChange={vi.fn()}
        onSubmit={vi.fn()}
        selectedModel="rose-labs/rose-1-flash"
      />,
    );
  }

  it('ends the toolbar with a bare info icon (no wrapper)', () => {
    renderQueryInput();
    const region = screen.getByTestId('query-toolbar-region');
    const trigger = within(region).getByTestId('query-info-trigger');
    const buttons = within(region).getAllByRole('button');
    expect(buttons[buttons.length - 1]).toBe(trigger);
    expect(trigger.className).not.toMatch(/\b(bg-|border|rounded|ring-\d|shadow)/);
    expect(trigger.querySelector('svg')).not.toBeNull();
  });

  it('opens a tiny menu with the three links resolving to the existing pages', async () => {
    const user = userEvent.setup();
    renderQueryInput();
    fireEvent.pointerEnter(screen.getByTestId('query-toolbar-nub'), { pointerType: 'mouse' });
    await user.click(screen.getByTestId('query-info-trigger'));
    const menu = await screen.findByTestId('query-info-menu');
    const links = within(menu).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['About', '/about'],
      ['Privacy', '/privacy'],
      ['Terms', '/terms'],
    ]);
    // Using the menu keeps the nub toolbar open (portaled focus bubbles).
    expect(screen.getByTestId('query-toolbar-region')).toHaveAttribute('data-state', 'open');
    await user.click(links[1]);
    await waitFor(() => expect(screen.queryByTestId('query-info-menu')).not.toBeInTheDocument());
  });
});

// ─── Pinned "Import Code Repo" goal ─────────────────────────────────────────

describe('pinned Import Code Repo goal', () => {
  const dripStyles = { borderRgb: 'rgb(0,0,0)' } as unknown as DripStyles;

  function renderCarousel(tickerOffset: number, onGoalClick = vi.fn()) {
    const tickerRef = { current: null };
    const ui = (offset: number) => (
      <PopularGoalsCarousel
        tickerOffset={offset}
        tickerRef={tickerRef}
        onGoalClick={onGoalClick}
        dripStyles={dripStyles}
        borderColor={0}
      />
    );
    const result = renderWithProviders(ui(tickerOffset));
    return { ...result, onGoalClick, rerenderAt: (o: number) => result.rerender(ui(o)) };
  }

  it('stays first and outside the moving track while the ticker scrolls', () => {
    const { rerenderAt } = renderCarousel(0);
    const pinned = screen.getByTestId('pinned-import-repo-goal');
    const track = screen.getByTestId('popular-goals-track');
    const row = pinned.parentElement as HTMLElement;
    const firstButton = () => within(row).getAllByRole('button')[0];

    expect(firstButton()).toBe(pinned);
    expect(track.contains(pinned)).toBe(false);
    expect(track.style.transform).toBe('translateX(-0px)');

    rerenderAt(137);
    expect(screen.getByTestId('popular-goals-track').style.transform).toBe('translateX(-137px)');
    expect(screen.getByTestId('pinned-import-repo-goal')).toBe(pinned);
    expect(firstButton()).toBe(pinned);
    expect(pinned.style.transform).toBe('');
    expect(pinned).toHaveClass('flex-none');
  });

  it('uses the navi-black pill, white label and a bare white→rose gradient import icon', () => {
    renderCarousel(0);
    const pinned = screen.getByTestId('pinned-import-repo-goal');
    expect(pinned).toHaveTextContent('Import Code Repo');
    expect(pinned).toHaveClass('bg-navi-black', 'text-white', 'rounded-full');
    const icon = within(pinned).getByTestId('pinned-import-repo-icon');
    expect(icon.parentElement).toBe(pinned);
    const stops = [...icon.querySelectorAll('stop')].map((s) => s.getAttribute('stop-color'));
    expect(stops).toEqual(['#fff', '#ffc2d4', '#ff5f8f']);
    const gradientId = icon.querySelector('linearGradient')?.getAttribute('id');
    expect(icon.querySelector('path')?.getAttribute('stroke')).toBe(`url(#${gradientId})`);
  });

  it('click hands the import goal to the shared popular-goal path', async () => {
    const user = userEvent.setup();
    const { onGoalClick } = renderCarousel(0);
    await user.click(screen.getByTestId('pinned-import-repo-goal'));
    expect(onGoalClick).toHaveBeenCalledWith(PINNED_IMPORT_REPO_GOAL);
  });

  it('prefills the composer on the Terminal page like other popular goals', async () => {
    const user = userEvent.setup({ delay: null });
    renderWithProviders(<Terminal />);
    await user.click(await screen.findByTestId('pinned-import-repo-goal'));
    expect(screen.getByPlaceholderText('Enter any goal')).toHaveValue('Import a code repo');
  });
});
