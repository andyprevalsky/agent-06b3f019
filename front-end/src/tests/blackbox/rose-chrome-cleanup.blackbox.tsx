/**
 * Blackbox tests for rose-user-ui "Chrome cleanup", mobile query box and
 * Popular Goals (UI ledger #11, #14, #15, #24, #55). Every change is behind the
 * Rose Desktop flag (lib/roseDesktop.ts): each block checks the flagged account
 * AND that the stock UI is unchanged.
 *  - #11 the mobile query box hugs the iPhone bottom display curve (safe-area
 *    padding, concentric bottom radius, viewport-fit=cover)
 *  - #14 Research / Careers and the legal footer are gone (the legal links
 *    move into the query box nub, owned by the query-box worker)
 *  - #15/#24 "Import Code Repo" is a plain goal pill, first in the rotation,
 *    followed by the new goals in order, then the stock goals
 *  - #55 the Popular Goals row is exactly as wide as the query box
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import Terminal from '@/pages/Terminal';
import { PopularGoalsCarousel } from '@/features/terminal/components/PopularGoalsCarousel';
import { POPULAR_GOALS, ROSE_DESKTOP_POPULAR_GOALS } from '@/features/terminal/config';
import type { DripStyles } from '@/features/terminal/types';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';

const API_BASE = 'http://localhost:3001/api';
const FRONT_END = process.cwd();
const ROSE_DESKTOP_USER = ROSE_DESKTOP_USER_IDS[0];
const STOCK_USER = 'test-user';

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

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

/** Renders the real Terminal signed in as a flagged (Rose Desktop) or stock account. */
async function renderTerminal(roseDesktop: boolean) {
  mockSession(roseDesktop ? ROSE_DESKTOP_USER : STOCK_USER);
  const result = renderWithProviders(<Terminal />);
  await screen.findByPlaceholderText('Enter any goal');
  return result;
}

beforeEach(() => {
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

// ─── #11 Mobile query box hugs the display curve ────────────────────────────

describe('mobile query box safe area (#11)', () => {
  const css = readFileSync(resolve(FRONT_END, 'src/index.css'), 'utf8');
  const RULE_HEAD = '@media (max-width: 767px) {\n  .rose-mobile-query-area [data-surface] {';

  function mobileRule(): string {
    const media = css.indexOf(RULE_HEAD);
    expect(media).toBeGreaterThan(-1);
    return css.slice(media, css.indexOf('\n}\n', media));
  }

  it('opts the page into the full display (viewport-fit=cover)', () => {
    const html = readFileSync(resolve(FRONT_END, 'index.html'), 'utf8');
    expect(html).toMatch(/name="viewport"[\s\S]*?content="[^"]*viewport-fit=cover/);
  });

  it('defines the display corner and a gap equal to the mobile column side inset', () => {
    expect(css).toMatch(/--display-corner:\s*55px;/);
    // MainContent pads the chat column px-2 (0.5rem) on mobile; the bottom gap matches.
    expect(css).toMatch(/--mobile-querybox-gap:\s*0\.5rem;/);
    expect(css).toMatch(/--safe-area-inset-bottom:\s*env\(safe-area-inset-bottom, 0px\);/);
  });

  it('matches the bottom corners to the display curve minus the gap (stock radius off-notch)', () => {
    const rule = mobileRule();
    expect(rule).toMatch(
      /--mobile-querybox-radius:\s*min\(\s*calc\(var\(--display-corner\) - var\(--mobile-querybox-gap\)\),\s*calc\(0\.75rem \+ var\(--safe-area-inset-bottom\) \* 2\)\s*\)/,
    );
    expect(rule).toMatch(/border-bottom-left-radius:\s*var\(--mobile-querybox-radius\)/);
    expect(rule).toMatch(/border-bottom-right-radius:\s*var\(--mobile-querybox-radius\)/);
    // Only the bottom corners change; the top keeps the box's rounded-xl curve.
    expect(rule).not.toMatch(/border-top-|border-radius:/);
  });

  it('pads the inside of the box by the rest of the bottom safe-area inset', () => {
    expect(mobileRule()).toMatch(
      /padding-bottom:\s*calc\(\s*0\.75rem \+ max\(0px, var\(--safe-area-inset-bottom\) - var\(--mobile-querybox-gap\)\)\s*\)/,
    );
  });

  it('Rose Desktop: the input area opts in and leaves one gap under the box', async () => {
    setViewport(390, 844);
    await renderTerminal(true);
    const inputArea = screen.getByTestId('terminal-input-area');
    expect(inputArea).toHaveClass('rose-mobile-query-area', 'pb-[var(--mobile-querybox-gap)]');
    expect(inputArea.className).not.toMatch(/safe-area-inset-bottom/);
    // The hug rule's [data-surface] target is the query box shell itself.
    const box = within(inputArea).getByTestId('query-input-surface');
    expect(box).toHaveAttribute('data-surface');
    expect(inputArea.querySelectorAll('[data-surface]')).toHaveLength(1);
    // Nothing (e.g. the old legal footer) sits between the box and the screen edge.
    expect(screen.queryByTestId('terminal-legal-links')).not.toBeInTheDocument();
  });

  it('stock: the input area keeps its safe-area padding and never opts in', async () => {
    setViewport(390, 844);
    await renderTerminal(false);
    const inputArea = screen.getByTestId('terminal-input-area');
    expect(inputArea).toHaveClass('pb-[calc(0.25rem+var(--safe-area-inset-bottom))]', 'md:pb-6');
    expect(inputArea).not.toHaveClass('rose-mobile-query-area');
    expect(document.querySelector('.rose-mobile-query-area')).toBeNull();
  });
});

// ─── #14 Research / Careers and the legal footer ────────────────────────────

describe('top nav chrome and legal footer (#14)', () => {
  it.each([
    ['desktop', 1280, 800],
    ['390px mobile', 390, 844],
  ])('Rose Desktop renders no Research, Careers or legal footer on %s', async (_l, w, h) => {
    setViewport(w, h);
    await renderTerminal(true);
    for (const name of ['Research', 'Careers']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('banner')).not.toHaveTextContent(/Research|Careers/);
    expect(screen.queryByTestId('terminal-legal-links')).not.toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
  });

  it.each([
    ['desktop', 1280, 800],
    ['390px mobile', 390, 844],
  ])('stock keeps Research, Careers (desktop) and the legal footer on %s', async (l, w, h) => {
    setViewport(w, h);
    await renderTerminal(false);
    expect(screen.getAllByRole('button', { name: 'Research' }).length).toBeGreaterThan(0);
    if (l === 'desktop') {
      expect(screen.getAllByRole('button', { name: 'Careers' }).length).toBeGreaterThan(0);
    }
    const footer = screen.getByTestId('terminal-legal-links');
    expect(within(footer).getByRole('link', { name: 'Privacy' })).toHaveAttribute(
      'href',
      '/privacy',
    );
    expect(within(footer).getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  });

  it('keeps the desktop Download link for both', async () => {
    setViewport(1280, 800);
    for (const roseDesktop of [true, false]) {
      const { unmount } = await renderTerminal(roseDesktop);
      expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/download');
      unmount();
      localStorage.clear();
    }
  });
});

// ─── #15 / #24 / #55 Popular Goals ──────────────────────────────────────────

describe('Popular Goals (#15, #24, #55)', () => {
  const dripStyles = { borderRgb: 'rgb(0,0,0)' } as unknown as DripStyles;
  const ROSE_DESKTOP_ORDER = [
    'Import Code Repo',
    'Make me a website',
    'Go to youtube.com',
    'Go to instagram.com',
    'Go to linkedin.com',
    'Change my background photo',
    'Make me a game',
  ];

  function renderCarousel(roseDesktop: boolean, tickerOffset = 0, onGoalClick = vi.fn()) {
    const tickerRef = createRef<HTMLDivElement>();
    const ui = (offset: number) => (
      <PopularGoalsCarousel
        tickerOffset={offset}
        tickerRef={tickerRef}
        onGoalClick={onGoalClick}
        dripStyles={dripStyles}
        borderColor={0}
      />
    );
    const result = renderWithProviders(ui(tickerOffset), { roseDesktop });
    return { ...result, onGoalClick, rerenderAt: (o: number) => result.rerender(ui(o)) };
  }

  function trackGoals(): string[] {
    return within(screen.getByTestId('popular-goals-track'))
      .getAllByRole('button')
      .map((b) => b.textContent ?? '');
  }

  it('Rose Desktop rotation starts with the spec order, then the stock goals', () => {
    renderCarousel(true);
    expect(ROSE_DESKTOP_POPULAR_GOALS).toEqual(ROSE_DESKTOP_ORDER);
    const goals = trackGoals();
    expect(goals.slice(0, ROSE_DESKTOP_ORDER.length)).toEqual(ROSE_DESKTOP_ORDER);
    expect(goals.slice(ROSE_DESKTOP_ORDER.length, ROSE_DESKTOP_ORDER.length + 3)).toEqual(
      POPULAR_GOALS.slice(0, 3),
    );
    // Every goal appears in each of the three ticker copies, never pinned twice.
    expect(goals.filter((g) => g === 'Import Code Repo')).toHaveLength(3);
  });

  it('Import Code Repo is a plain pill inside the moving track (not pinned)', () => {
    const { rerenderAt } = renderCarousel(true);
    expect(screen.queryByTestId('pinned-import-repo-goal')).not.toBeInTheDocument();
    const track = screen.getByTestId('popular-goals-track');
    const [importRepo, website] = within(track).getAllByRole('button');
    expect(importRepo).toHaveTextContent(/^Import Code Repo$/);
    // Same pill as every other goal: identical classes, no icon, no special colors.
    expect(importRepo.className).toBe(website.className);
    expect(importRepo.querySelector('svg')).toBeNull();
    expect(importRepo.className).not.toMatch(/navi-black|text-white/);
    // It scrolls with the ticker like the rest.
    rerenderAt(137);
    expect(track.style.transform).toBe('translateX(-137px)');
    expect(track.contains(importRepo)).toBe(true);
  });

  it('stock shows only the stock goals', () => {
    renderCarousel(false);
    const goals = trackGoals();
    expect(goals.slice(0, POPULAR_GOALS.length)).toEqual(POPULAR_GOALS);
    for (const goal of ROSE_DESKTOP_ORDER) expect(goals).not.toContain(goal);
  });

  it('Rose Desktop row is exactly the query box width with a 30px gap to the box', () => {
    renderCarousel(true);
    const row = screen.getByTestId('popular-goals-row');
    // Same width constraint + centering as QueryInput's max-w-4xl mx-auto
    // container, so the left edge and the pills' right cutoff match the box.
    expect(row).toHaveClass('w-full', 'max-w-4xl', 'mx-auto', 'mb-[30px]');
    expect(row).not.toHaveClass('mb-4');
    const viewport = screen.getByTestId('popular-goals-viewport');
    expect(viewport).toHaveClass('flex-1', 'min-w-0', 'overflow-hidden');
  });

  it('stock row keeps its original spacing and width', () => {
    renderCarousel(false);
    const row = screen.getByTestId('popular-goals-row');
    expect(row).toHaveClass('mb-4', 'relative', 'z-10');
    expect(row).not.toHaveClass('max-w-4xl', 'mx-auto', 'mb-[30px]');
  });

  it('Rose Desktop Terminal: the goals row and the query box share one width box', async () => {
    setViewport(1280, 800);
    await renderTerminal(true);
    const inputArea = screen.getByTestId('terminal-input-area');
    const row = within(inputArea).getByTestId('popular-goals-row');
    const box = within(inputArea).getByTestId('query-input-surface');
    const boxContainer = box.parentElement as HTMLElement;
    expect(boxContainer).toHaveClass('max-w-4xl', 'mx-auto');
    for (const cls of ['max-w-4xl', 'mx-auto']) expect(row).toHaveClass(cls);
    // Both sit directly in the full-width input column (no extra side padding on the row).
    expect(row.parentElement).toBe(inputArea);
    expect(row.className).not.toMatch(/\b(px|mx)-\d/);
  });

  it('Rose Desktop Terminal: clicking Import Code Repo prefills the composer', async () => {
    const user = userEvent.setup({ delay: null });
    await renderTerminal(true);
    const [importRepo] = within(screen.getByTestId('popular-goals-track')).getAllByRole('button');
    await user.click(importRepo);
    expect(screen.getByPlaceholderText('Enter any goal')).toHaveValue('Import Code Repo');
  });
});
