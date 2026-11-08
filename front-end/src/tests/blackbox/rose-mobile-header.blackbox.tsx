/**
 * Blackbox: the Rose Desktop header on phones and iPads, through the real
 * Terminal (flag on) with the stock account as the control.
 *
 *   < 768px (phones 375-430, iPad mini 744): one opaque row (Back while an agent is open) —
 *     hamburger (left, opens the agents drawer from the LEFT) · the Rose pill
 *     (brand + bell, centered between) · the four app icons (Browser, Phone,
 *     Integrations + red reconnect dot, Dark mode) — every target >= 40px, the
 *     side groups fixed width and the pill shrinkable, so nothing overlaps.
 *     App drawers and the Phone open full screen with their own close X.
 *   >= 768px (iPad portrait 768-834, landscape 1024-1194): the desktop pill
 *     (centered, 320px max) + the top-right icon row + the 64px left rail,
 *     with room between them at every width.
 *   Stock account: the stock mobile bar (brand left, hamburger right), no icons.
 * jsdom has no layout engine: widths are asserted from the declared sizes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { appIconsInset } from '@/features/terminal-component-group/components/rose-apps/roseAppsLayout';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import * as roseDesktopFlag from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';
const ROSE_USER = ROSE_DESKTOP_USER_IDS[0];
const APP_LABELS = ['Browser', 'Phone', 'Integrations', 'Dark mode'];
/** Declared widths (px) of the mobile row's fixed parts. */
const ROW_PADDING = 2 * 6; // px-1.5
const ROW_GAPS = 2 * 4; // gap-1 between the three groups
const TARGET = 40;

function setViewport(width: number, height = 844) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function signInAs(userId: string) {
  const user = { id: userId, is_anonymous: false };
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'test-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user,
    }),
  );
  localStorage.setItem('app-user', JSON.stringify(user));
}

async function renderTerminal(userId = ROSE_USER) {
  signInAs(userId);
  const user = userEvent.setup({ delay: null });
  renderWithProviders(<Terminal />);
  await screen.findByPlaceholderText('Enter any goal');
  if (window.innerWidth < 768 && roseDesktopFlag.isRoseDesktopUser({ id: userId })) {
    await screen.findByTestId('rose-mobile-header');
  }
  return user;
}

const header = () => screen.getByTestId('rose-mobile-header');

function px(el: HTMLElement, prop: 'width' | 'height'): number {
  return Number.parseFloat(el.style[prop]);
}

/** Each control's target: inline size (app icons) or Tailwind h-10/w-10 (40px). */
function expectTarget(el: HTMLElement) {
  if (el.style.width !== '') {
    expect(px(el, 'width')).toBeGreaterThanOrEqual(TARGET);
    expect(px(el, 'height')).toBeGreaterThanOrEqual(TARGET);
  } else {
    expect(el.className).toMatch(/\bh-10\b/);
    expect(el.className).toMatch(/\bw-10\b/);
  }
}

beforeEach(() => {
  localStorage.clear();
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
  vi.restoreAllMocks();
  setViewport(1024, 768);
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

describe('Rose mobile header (flag on, < 768px)', () => {
  it.each([375, 390, 430, 744])(
    'at %ipx: menu left · actions middle · Rose icon far right, all >= 40px',
    async (width) => {
      setViewport(width);
      await renderTerminal();
      const row = header();
      const groups = [...row.children] as HTMLElement[];
      expect(groups).toHaveLength(3);
      const menu = within(groups[0]).getByRole('button', { name: 'Open menu' });
      const icons = within(groups[1]).getByRole('navigation', { name: 'Apps' });
      const bell = within(groups[1]).getByRole('button', { name: 'Attention requests' });
      const rose = within(groups[2]).getByRole('button', { name: 'Rose' });
      expect(icons).toHaveAttribute('data-placement', 'header');
      const appButtons = within(icons).getAllByRole('button');
      expect(
        appButtons.map((b) => b.getAttribute('aria-label')?.replace('Light mode', 'Dark mode')),
      ).toEqual(APP_LABELS);
      for (const target of [menu, bell, rose, ...appButtons]) expectTarget(target);
      expect(groups[0].className).toContain('flex-none');
      expect(groups[2].className).toContain('flex-none');
      expect(groups[1].className).toContain('justify-end');
      expect(width - ROW_PADDING - ROW_GAPS).toBeGreaterThanOrEqual(
        (APP_LABELS.length + 3) * TARGET,
      );
      // Only one icon row on screen: the corner one stays desktop-only.
      expect(screen.getAllByRole('navigation', { name: 'Apps' })).toHaveLength(1);
    },
  );

  it('the hamburger opens the agents drawer from the left', async () => {
    setViewport(390);
    const user = await renderTerminal();
    await user.click(within(header()).getByRole('button', { name: 'Open menu' }));
    const drawer = await screen.findByRole('dialog');
    expect(drawer.className).toContain('left-0');
    expect(drawer.className).toContain('data-[state=open]:slide-in-from-left');
    expect(drawer.className).toContain('w-screen');
    expect(within(drawer).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Agents' })).toBeInTheDocument();
  });

  it('keeps the Integrations red reconnect dot', async () => {
    server.use(
      http.get(`${API_BASE}/integrations`, () =>
        HttpResponse.json({
          integrations: [
            {
              name: 'gmail',
              status: 'CONNECTED',
              emailCredentials: [{ email: 'a@b.c', state: 'needs_reconnect' }],
            },
          ],
        }),
      ),
    );
    setViewport(390);
    await renderTerminal();
    const icons = within(header()).getByRole('navigation', { name: 'Apps' });
    const dot = await within(icons).findByTestId('rose-app-integrations-alert');
    expect(dot.className).toContain('bg-[#ef4444]');
  });

  it('Integrations and Phone open full screen with their own close X', async () => {
    setViewport(390);
    const user = await renderTerminal();
    await user.click(within(header()).getByRole('button', { name: 'Integrations' }));
    // The test wrapper mounts its own (idle) RoseAppsProvider too: take the open panel.
    const openPanel = () =>
      screen.getAllByTestId('rose-app-panel').find((el) => el.dataset.state === 'open');
    await waitFor(() => expect(openPanel()).toBeDefined());
    const panel = openPanel()!;
    expect(panel).toHaveAttribute('aria-label', 'Integrations panel');
    expect(panel.className).toContain('inset-0');
    expect(panel.className).not.toMatch(/rounded-t/);
    const close = within(panel).getByRole('button', { name: 'Close integrations panel' });
    expect(close.className).toMatch(/\bh-10\b/);
    await user.click(close);
    await waitFor(() => expect(panel).toHaveAttribute('data-state', 'closed'));

    await user.click(within(header()).getByRole('button', { name: 'Phone' }));
    const phone = await screen.findByTestId('rose-phone');
    expect(phone).toHaveAttribute('data-mobile', 'true');
    expect(phone.className).toContain('inset-0');
    expect(phone.className).not.toContain('hidden');
    await user.click(within(phone).getByRole('button', { name: 'Close phone' }));
    await waitFor(() => expect(screen.queryByTestId('rose-phone')).toBeNull());
  });

  it('login dark mode and manual header toggle keep the far-right Rose icon accessible', async () => {
    setViewport(390);
    const user = await renderTerminal();
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
    expect(within(header()).getByRole('button', { name: 'Rose' })).toBeInTheDocument();
    await user.click(within(header()).getByRole('button', { name: 'Light mode' }));
    expect(document.documentElement).not.toHaveClass('dark');
    await user.click(within(header()).getByRole('button', { name: 'Dark mode' }));
    expect(document.documentElement).toHaveClass('dark');
  });
});

describe('Rose header frame beside the left bar (flag on, desktop)', () => {
  it('centres the pill on the content area: its frame starts at the pinned bar offset', async () => {
    setViewport(1440, 900);
    await renderTerminal();
    const banner = screen.getByRole('banner');
    const frame = screen.getByTestId('terminal-header-frame');
    expect(banner.parentElement).toBe(frame);
    expect(banner.className).toContain('left-1/2');
    expect(frame.className).toContain('md:left-[var(--rose-bar-offset,0px)]');
    expect(document.documentElement.style.getPropertyValue('--rose-bar-offset')).toBe('64px');

    const handle = screen.getByTestId('rose-sidebar-resize-handle');
    act(() => {
      fireEvent.pointerDown(handle);
    });
    act(() => {
      fireEvent.pointerMove(window, { clientX: 420 });
    });
    act(() => {
      fireEvent.pointerUp(window, { clientX: 420 });
    });
    expect(document.documentElement.style.getPropertyValue('--rose-bar-offset')).toBe('420px');
    expect(screen.getByRole('banner').parentElement).toBe(frame);
    localStorage.removeItem('rose-sidebar-width');
    localStorage.removeItem('rose-sidebar-pinned');
  });
});

describe('Rose header on iPad (flag on, >= 768px)', () => {
  it.each([768, 810, 834, 1024, 1180, 1194])(
    'at %ipx: desktop pill + corner icons + left rail, clear of each other',
    async (width) => {
      setViewport(width, 1024);
      await renderTerminal();
      expect(screen.queryByTestId('rose-mobile-header')).toBeNull();
      const banner = screen.getByRole('banner');
      expect(banner.className).toContain('left-1/2');
      expect(within(banner).getByRole('button', { name: /Rose/ })).toBeInTheDocument();
      expect(within(banner).getByRole('button', { name: 'Attention requests' })).toBeVisible();
      const icons = screen.getByRole('navigation', { name: 'Apps' });
      expect(icons).toHaveAttribute('data-placement', 'corner');
      expect(within(icons).getAllByRole('button')).toHaveLength(4);
      expect(screen.getByTestId('rose-sidebar')).toBeInTheDocument();
      // Centered 320px pill vs the 64px rail (left) and the icon row (right).
      const pillLeft = width / 2 - 160;
      const pillRight = width / 2 + 160;
      expect(pillLeft).toBeGreaterThan(64);
      expect(pillRight).toBeLessThan(width - appIconsInset(4));
    },
  );
});

describe('explicit legacy flag override', () => {
  it('keeps the stock mobile bar: brand left, hamburger right, no app icons', async () => {
    setViewport(390);
    vi.spyOn(roseDesktopFlag, 'isRoseDesktopUser').mockReturnValue(false);
    await renderTerminal('test-user');
    expect(screen.queryByTestId('rose-mobile-header')).toBeNull();
    const banner = screen.getByRole('banner');
    expect(banner.className).toContain('grid-cols-3');
    const [left, , right] = [...banner.children] as HTMLElement[];
    expect(within(left).getByRole('button', { name: /Rose/ })).toBeInTheDocument();
    expect(within(right).getByRole('button', { name: 'Open menu' })).toHaveClass('h-9');
    expect(screen.queryByRole('navigation', { name: 'Apps' })).toBeNull();
  });
});

describe('all-account rollout', () => {
  it('gives an ordinary signed-in account the mobile app header', async () => {
    setViewport(390);
    await renderTerminal('ordinary-account');
    expect(header()).toBeInTheDocument();
    const icons = within(header()).getByRole('navigation', { name: 'Apps' });
    expect(
      within(icons)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')?.replace('Light mode', 'Dark mode')),
    ).toEqual(APP_LABELS);
  });
});
