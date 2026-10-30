/**
 * Blackbox tests for rose-user-ui "Chrome cleanup", mobile query box and
 * Popular Goals (UI ledger #11, #14, #15, #24, #55, #66). Every change is behind the
 * Rose Desktop flag (lib/roseDesktop.ts): each block checks the flagged account
 * AND that the stock UI is unchanged.
 *  - #11 the mobile query box hugs the iPhone bottom display curve (safe-area
 *    padding, concentric bottom radius, viewport-fit=cover)
 *  - #14/#66 no top-right nav links (Research, Careers, Download) and no legal
 *    footer (the legal links move into the query box nub, owned by the
 *    query-box worker); the stock website keeps all of them
 *  - #15/#24 "Import Code Repo" is a plain goal pill, first in the rotation,
 *    followed by the new goals in order, then the stock goals minus four
 *  - #55 the Popular Goals row is exactly as wide as the query box
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { expandBar, makeProject, mockProjectsApi } from './rose-sidebar.fixtures';
import Terminal from '@/pages/Terminal';
import { PopularGoalsCarousel } from '@/features/terminal/components/PopularGoalsCarousel';
import {
  POPULAR_GOALS,
  ROSE_DESKTOP_HIDDEN_POPULAR_GOALS,
  ROSE_DESKTOP_POPULAR_GOALS,
} from '@/features/terminal/config';
import type { DripStyles } from '@/features/terminal/types';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import * as roseDesktopFlag from '@/lib/roseDesktop';

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
async function renderTerminal(roseDesktop: boolean, signedIn = true) {
  if (!roseDesktop) vi.spyOn(roseDesktopFlag, 'isRoseDesktopUser').mockReturnValue(false);
  if (signedIn) mockSession(roseDesktop ? ROSE_DESKTOP_USER : STOCK_USER);
  else localStorage.clear();
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
    // The flagged account is an admin: its left bar prewarms Biz health on mount.
    http.get(`${API_BASE}/admin-health`, () =>
      HttpResponse.json({ error: 'admin health not mocked' }, { status: 503 }),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('sizes and places the app shell from the iOS visible-viewport vars', async () => {
    setViewport(430, 932);
    await renderTerminal(true);
    const shell = screen.getByTestId('terminal-app-shell');
    // initViewportHeight writes these: full screen in the PWA, keyboard top while typing.
    expect(shell.style.height).toBe('var(--app-height, 100dvh)');
    expect(shell.style.top).toBe('var(--app-top, 0px)');
    expect(shell).toHaveClass('fixed');
    expect(screen.getByRole('main').style.height).toBe('var(--app-height, 100dvh)');
  });

  it('Rose Desktop: the input area opts in and leaves one gap under the box', async () => {
    setViewport(390, 844);
    await renderTerminal(true);
    const inputArea = screen.getByTestId('terminal-input-area');
    expect(inputArea).toHaveClass('rose-mobile-query-area', 'pb-[var(--mobile-querybox-gap)]');
    expect(inputArea.className).not.toMatch(/safe-area-inset-bottom/);
    // The hug rule's [data-surface] target is the query box shell itself.
    const layer = screen.getByTestId('query-input-layer');
    expect(layer).toHaveClass('rose-mobile-query-area');
    const box = within(layer).getByTestId('query-input-surface');
    expect(box).toHaveAttribute('data-surface');
    expect(layer.querySelectorAll('[data-surface]')).toHaveLength(1);
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

describe('top nav chrome and legal footer (#14, #66)', () => {
  it.each([false, true])(
    'installed mobile PWA hides public links before login (Rose=%s)',
    async (rose) => {
      setViewport(390, 844);
      const matchMedia = window.matchMedia.bind(window);
      const spy = vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
        ...matchMedia(query),
        matches: query === '(display-mode: standalone)' || matchMedia(query).matches,
      }));
      try {
        await renderTerminal(rose, false);
        for (const name of ['Research', 'Careers', 'About', 'Privacy', 'Terms']) {
          expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
          expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
        }
        expect(screen.queryByTestId('query-info-trigger')).not.toBeInTheDocument();
        expect(screen.queryByTestId('terminal-legal-links')).not.toBeInTheDocument();
      } finally {
        spy.mockRestore();
      }
    },
  );

  it.each([
    ['stock mobile', false, 390, 844],
    ['stock desktop', false, 1280, 800],
    ['Rose mobile', true, 390, 844],
    ['Rose desktop', true, 1280, 800],
  ] as const)(
    'signed-in %s contains no public-site navigation or legal menu',
    async (_label, rose, width, height) => {
      setViewport(width, height);
      await renderTerminal(rose);
      await waitFor(() => {
        for (const name of ['Research', 'Careers', 'About', 'Privacy', 'Terms']) {
          expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
          expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
        }
        expect(screen.queryByTestId('query-info-trigger')).not.toBeInTheDocument();
        expect(screen.queryByTestId('terminal-legal-links')).not.toBeInTheDocument();
      });
    },
  );

  it.each([
    ['desktop', 1280, 800],
    ['390px mobile', 390, 844],
  ])('Rose Desktop renders no top nav links or legal footer on %s', async (_l, w, h) => {
    setViewport(w, h);
    await renderTerminal(true);
    for (const name of ['Research', 'Careers', 'Download']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('banner')).not.toHaveTextContent(/Research|Careers|Download/);
    expect(document.querySelector('a[href="/download"]')).toBeNull();
    expect(screen.queryByTestId('terminal-legal-links')).not.toBeInTheDocument();
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument();
  });

  it.each([
    ['desktop', 1280, 800],
    ['390px mobile', 390, 844],
  ])('signed-out stock keeps public links on %s', async (l, w, h) => {
    setViewport(w, h);
    await renderTerminal(false, false);
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

  it('stock keeps the desktop Download link', async () => {
    setViewport(1280, 800);
    await renderTerminal(false);
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/download');
  });
});

// ─── #15 / #24 / #55 Popular Goals ──────────────────────────────────────────

describe('Popular Goals (#15, #24, #55)', () => {
  const dripStyles = { borderRgb: 'rgb(0,0,0)' } as unknown as DripStyles;
  const ROSE_DESKTOP_ORDER = [
    'Import Code Repo',
    'Maximize my luck surface area',
    'End world hunger',
    'Go to youtube.com',
    'Raise me 1 million dollars',
    'Make sure I accomplish my body goals',
    'Make me an app',
    'Get me 5 new friends',
    'Mitigate the impending climate crisis',
    'Get me socks',
    'Make me a master painter',
    'Go to instagram.com',
    'Make me a website',
    'Find me my first 10 customers',
    'Get me a girlfriend',
    'Optimize my nutrition',
    'Get Rose Api Key',
    'Ensure my friends are well supported',
    'Make sure my birthday is amazing',
    'Make me a game',
    'Go to linkedin.com',
    'Cure cancer',
    'Make sure my startup succeeds',
    'Get me a boyfriend',
    'Change my background photo',
  ];
  const HIDDEN_FOR_ROSE_DESKTOP = [
    'Get me into Stanford',
    'Make me happy',
    'Make sure my parents are taken care of',
    'Save children in Gaza',
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

  it('Rose Desktop rotation interlaces all 25 goals without omissions or duplicates', () => {
    renderCarousel(true);
    expect(ROSE_DESKTOP_POPULAR_GOALS).toEqual(ROSE_DESKTOP_ORDER);
    expect([...ROSE_DESKTOP_HIDDEN_POPULAR_GOALS].sort()).toEqual(
      [...HIDDEN_FOR_ROSE_DESKTOP].sort(),
    );
    const goals = trackGoals();
    const expectedStockTail = POPULAR_GOALS.filter((g) => !HIDDEN_FOR_ROSE_DESKTOP.includes(g));
    expect(expectedStockTail).toHaveLength(POPULAR_GOALS.length - HIDDEN_FOR_ROSE_DESKTOP.length);
    // One complete, interlaced rotation; every retained stock topic remains present.
    const oneCopy = ROSE_DESKTOP_ORDER;
    expect(new Set(oneCopy).size).toBe(25);
    for (const goal of expectedStockTail) expect(oneCopy).toContain(goal);
    expect(goals.slice(0, oneCopy.length)).toEqual(oneCopy);
    expect(goals).toHaveLength(oneCopy.length * 3);
    for (const hidden of HIDDEN_FOR_ROSE_DESKTOP) expect(goals).not.toContain(hidden);
    // Every goal appears in each of the three ticker copies, never pinned twice.
    expect(goals.filter((g) => g === 'Import Code Repo')).toHaveLength(3);
  });

  it('Import Code Repo is a plain pill inside the moving track (not pinned)', () => {
    const { rerenderAt } = renderCarousel(true);
    expect(screen.queryByTestId('pinned-import-repo-goal')).not.toBeInTheDocument();
    const track = screen.getByTestId('popular-goals-track');
    const [importRepo, nextGoal] = within(track).getAllByRole('button');
    expect(importRepo).toHaveTextContent(/^Import Code Repo$/);
    // Same pill as every other goal: identical classes, no icon, no special colors.
    expect(importRepo.className).toBe(nextGoal.className);
    expect(importRepo.querySelector('svg')).toBeNull();
    expect(importRepo.className).not.toMatch(/navi-black|text-white/);
    // It scrolls with the ticker like the rest.
    rerenderAt(137);
    expect(track.style.transform).toBe('translateX(-137px)');
    expect(track.contains(importRepo)).toBe(true);
  });

  it('stock shows only the stock goals, unchanged (including the four hidden for Rose Desktop)', () => {
    renderCarousel(false);
    const goals = trackGoals();
    expect(goals.slice(0, POPULAR_GOALS.length)).toEqual(POPULAR_GOALS);
    expect(goals).toHaveLength(POPULAR_GOALS.length * 3);
    for (const hidden of HIDDEN_FOR_ROSE_DESKTOP) expect(goals).toContain(hidden);
    for (const goal of ROSE_DESKTOP_ORDER.filter((goal) => !POPULAR_GOALS.includes(goal))) {
      expect(goals).not.toContain(goal);
    }
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

  it('Rose Desktop Terminal: composer is lifted above apps and Popular Goals are absent', async () => {
    setViewport(1280, 800);
    await renderTerminal(true);
    expect(screen.queryByTestId('popular-goals-row')).not.toBeInTheDocument();
    const layer = screen.getByTestId('query-input-layer');
    expect(layer.parentElement).toBe(document.body);
    expect(layer).toHaveClass('z-[100]');
    expect(within(layer).getByTestId('query-input-host')).toHaveClass('max-w-4xl', 'mx-auto');
    expect(within(layer).getByTestId('query-toolbar-nub')).toBeInTheDocument();
  });

  it('Rose Desktop Terminal: the floating composer is pinned by its bottom edge, so growth extends upward', async () => {
    setViewport(1280, 800);
    await renderTerminal(true);
    const layer = screen.getByTestId('query-input-layer');
    // Pinned by top, a growing agents-running pane pushed the box below its slot
    // for the frames before the anchor caught up, then it jumped up.
    expect(layer.style.top).toBe('');
    expect(layer.style.bottom).toMatch(/^-?\d+(\.\d+)?px$/);
  });

  it('Rose Desktop Terminal: custom goals remain editable without the ticker', async () => {
    const user = userEvent.setup({ delay: null });
    await renderTerminal(true);
    expect(screen.queryByTestId('popular-goals-track')).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText('Enter any goal');
    await user.type(input, 'Import my repository');
    expect(input).toHaveValue('Import my repository');
  });
});

// ─── UI review: one stacking order + composer continuity ────────────────────
//
// Rose Desktop layers that compete at the page root (lowest first):
//   page content (the z-[4] main row) < composer (+ its attached agents-running
//   pane) < panels that cover it (project settings, Biz health, Browser,
//   Integrations) < popovers opened from any of them.
// jsdom has no layout, so the assertions compare the z of the OUTERMOST
// z-indexed ancestor of each element: an element inside a lower stacking
// context can never paint above a higher root layer, whatever its own z.

function rootLayerZ(element: Element): number {
  let z = Number.NaN;
  for (
    let node: Element | null = element;
    node !== null && node !== document.body;
    node = node.parentElement
  ) {
    const match = /(?:^|\s)z-\[?(-?\d+)\]?(?=\s|$)/.exec(node.getAttribute('class') ?? '');
    if (match) z = Number(match[1]);
  }
  return z;
}

describe('Rose Desktop stacking order and composer continuity (UI review 1/13/14)', () => {
  beforeEach(() => {
    setViewport(1280, 800);
    mockProjectsApi([makeProject()]);
  });

  it('project settings opened from the left bar stacks above the floating query box', async () => {
    const user = userEvent.setup({ delay: null });
    await renderTerminal(true);
    expandBar();
    await user.click(await screen.findByRole('button', { name: 'Rose project settings' }));
    const panel = screen.getByTestId('rose-project-settings');
    const composer = screen.getByTestId('query-input-layer');
    expect(rootLayerZ(composer)).toBe(100);
    expect(rootLayerZ(panel)).toBeGreaterThan(rootLayerZ(composer));
  });

  it('an app opened while project settings is open covers the drawer, not the reverse', async () => {
    const user = userEvent.setup({ delay: null });
    await renderTerminal(true);
    expandBar();
    await user.click(await screen.findByRole('button', { name: 'Rose project settings' }));
    const settings = screen.getByTestId('rose-project-settings');
    // Read before Browser opens: the open Browser docks the composer in its own pane.
    const composer = rootLayerZ(screen.getByTestId('query-input-layer'));
    await user.click(screen.getByTestId('rose-app-browser'));
    const browser = screen
      .getAllByTestId('browser-app-drawer')
      .find((drawer) => drawer.dataset.state === 'open');
    expect(browser).toBeDefined();
    if (browser === undefined) return;
    expect(screen.getByTestId('rose-project-settings')).toBe(settings);
    expect(rootLayerZ(settings)).toBeGreaterThan(composer);
    expect(rootLayerZ(browser)).toBeGreaterThan(rootLayerZ(settings));
    // The icon row stays clickable over the covering panel.
    expect(rootLayerZ(screen.getByTestId('rose-app-icons'))).toBeGreaterThan(rootLayerZ(browser));
  });

  it('project settings ends left of the top-right app icon row on narrow windows', async () => {
    const user = userEvent.setup({ delay: null });
    setViewport(800, 800);
    await renderTerminal(true);
    expandBar();
    await user.click(await screen.findByRole('button', { name: 'Rose project settings' }));
    const settings = screen.getByTestId('rose-project-settings');
    // RoseAppsProvider publishes the icon row's width; the drawer subtracts it.
    expect(document.documentElement.style.getPropertyValue('--rose-app-icons-inset')).toMatch(
      /px$/,
    );
    expect(settings.style.width).toContain('var(--rose-app-icons-inset');
    expect(settings.style.width).toContain(`100vw - ${settings.style.left}`);
  });

  it('the Rose toolset popover stacks above the query box and its agents-running header', async () => {
    await renderTerminal(true);
    const composer = screen.getByTestId('query-input-layer');
    fireEvent.mouseEnter(within(composer).getByTestId('pinned-toolset-chip'));
    const heading = await screen.findByText('Built-in tools available to all Rose agents');
    expect(composer.contains(heading)).toBe(false);
    expect(rootLayerZ(heading)).toBeGreaterThan(rootLayerZ(composer));
  });

  it('starting an agent keeps the same query box mounted through creation and detail load', async () => {
    const user = userEvent.setup({ delay: null });
    let releaseDetail: () => void = () => undefined;
    const detailHeld = new Promise<void>((resolve) => {
      releaseDetail = resolve;
    });
    let detailRequested = false;
    server.use(
      http.get(`${API_BASE}/agents/:agentId`, async ({ params }) => {
        if (params.agentId === 'search' || params.agentId === 'code-agents') return undefined;
        detailRequested = true;
        await detailHeld;
        return HttpResponse.json({
          agent: {
            agent_id: params.agentId,
            goal: 'Plan my week',
            model: 'rose-1-flash',
            status: 'STARTING_UP',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            parent_agent_id: null,
          },
          messages: [],
          pagination: { has_more: false, oldest_timestamp: null },
        });
      }),
      http.post(`${API_BASE}/agents`, async ({ request }) => {
        const body = (await request.json()) as { agent_id: string };
        return HttpResponse.json({ agent_id: body.agent_id, status: 'STARTING_UP' });
      }),
    );
    await renderTerminal(true);
    const input = screen.getByPlaceholderText('Enter any goal');
    const composer = screen.getByTestId('query-input-layer');
    await user.type(input, 'Plan my week');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(detailRequested).toBe(true));
    // While the created agent's detail loads, the box is the same node, still interactive.
    expect(screen.queryByText(/Loading agent details/)).not.toBeInTheDocument();
    expect(composer.isConnected).toBe(true);
    expect(input.isConnected).toBe(true);
    releaseDetail();
    await waitFor(() => expect(screen.getByPlaceholderText('Type your message...')).toBe(input));
    expect(composer.isConnected).toBe(true);
  });
});

// ─── Mobile trajectory text reads 2px larger ─────────────────────────────────

describe('mobile trajectory text', () => {
  const css = readFileSync(resolve(FRONT_END, 'src/index.css'), 'utf8');

  it('bumps every message-list text size by 2px on phones only', () => {
    const start = css.indexOf('@media (max-width: 767px) {\n  .rose-trajectory');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('\n}\n', start));
    expect(rule).toMatch(/\.rose-trajectory \.text-xs \{\s*font-size: calc\(0\.75rem \+ 2px\)/);
    expect(rule).toMatch(
      /\.rose-trajectory \.text-sm,\s*\.rose-trajectory \.prose-sm \{\s*font-size: calc\(0\.875rem \+ 2px\)/,
    );
    // Every arbitrary px size used by trajectory components has a +2px override,
    // so a newly introduced size cannot silently stay small on mobile.
    const dir = resolve(FRONT_END, 'src/features/terminal-component-group/components');
    const sources = execSync(`grep -rhoE "text-\\[[0-9.]+px\\]" ${dir} --include=*.tsx || true`)
      .toString()
      .split('\n')
      .filter(Boolean);
    for (const size of new Set(sources)) {
      const px = Number(size.slice(6, -3));
      const selector = `.rose-trajectory .${size.replace(/[[\].]/g, (c) => `\\${c}`)}`;
      expect(rule, size).toContain(`${selector} {\n    font-size: ${px + 2}px;`);
    }
  });
});
