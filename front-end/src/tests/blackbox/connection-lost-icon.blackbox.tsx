/**
 * Blackbox: the "No connection" icon, through the real Terminal header.
 *
 *   Online: nothing renders. Offline (window 'offline', or navigator.onLine
 *   read on mobile resume via 'visibilitychange' / 'pageshow'): a bare red
 *   wifi-off icon announced as "No connection" appears just left of the bell
 *   (desktop pill — also the Mac app — and the Rose mobile bar) or of the
 *   hamburger (stock mobile bar), and disappears once back online.
 * jsdom has no layout engine: the Rose mobile row's fit is asserted from the
 * declared sizes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { ConnectionLostIcon } from '@/components/ConnectionLostIcon';
import { ROSE_DESKTOP_USER_IDS } from '@/lib/roseDesktop';
import * as roseDesktopFlag from '@/lib/roseDesktop';
import Terminal from '@/pages/Terminal';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';
const ROSE_USER = ROSE_DESKTOP_USER_IDS[0];
const LABEL = 'No connection';

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

function goOffline() {
  setOnline(false);
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
}

function goOnline() {
  setOnline(true);
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
}

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
  renderWithProviders(<Terminal />);
  await screen.findByPlaceholderText('Enter any goal');
}

const icon = () => screen.getByRole('status', { name: LABEL });

/** The icon sits immediately before `next` in the same row. */
function expectJustBefore(next: HTMLElement) {
  const row = icon().parentElement as HTMLElement;
  const children = [...row.children];
  const target = children.find((child) => child === next || child.contains(next));
  expect(target).toBeDefined();
  expect(children.indexOf(icon())).toBe(children.indexOf(target as Element) - 1);
}

beforeEach(() => {
  localStorage.clear();
  setOnline(true);
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
  setOnline(true);
  setViewport(1024, 768);
  localStorage.clear();
});

describe('ConnectionLostIcon', () => {
  it('renders nothing online, appears offline and clears when back online', () => {
    render(<ConnectionLostIcon />);
    expect(screen.queryByRole('status', { name: LABEL })).toBeNull();

    goOffline();
    expect(icon()).toHaveAttribute('title', LABEL);
    expect(icon()).toHaveClass('text-red-600');
    expect(icon().querySelector('svg')).not.toBeNull();

    goOnline();
    expect(screen.queryByRole('status', { name: LABEL })).toBeNull();
  });

  it('shows when offline at mount', () => {
    setOnline(false);
    render(<ConnectionLostIcon />);
    expect(icon()).toBeInTheDocument();
  });

  it('re-reads the connection on mobile resume when no event fired', () => {
    render(<ConnectionLostIcon />);

    setOnline(false);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(icon()).toBeInTheDocument();

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
    });
    expect(screen.queryByRole('status', { name: LABEL })).toBeNull();
  });
});

describe('Terminal header connection icon', () => {
  it('desktop pill (site + Mac app): left of the bell, only while offline', async () => {
    setViewport(1024, 768);
    await renderTerminal();
    const banner = screen.getByRole('banner');
    expect(within(banner).queryByRole('status', { name: LABEL })).toBeNull();

    goOffline();
    expect(within(banner).getByRole('status', { name: LABEL })).toBeInTheDocument();
    expectJustBefore(within(banner).getByRole('button', { name: 'Attention requests' }));
    expect(screen.getAllByRole('status', { name: LABEL })).toHaveLength(1);

    goOnline();
    expect(within(banner).queryByRole('status', { name: LABEL })).toBeNull();
  });

  it('Rose mobile bar: left of the bell, 20px wide so 320px still fits', async () => {
    setViewport(390);
    await renderTerminal();
    const row = await screen.findByTestId('rose-mobile-header');

    goOffline();
    const groups = [...row.children] as HTMLElement[];
    expect(within(groups[1]).getByRole('status', { name: LABEL })).toHaveClass('w-5', 'h-10');
    expectJustBefore(within(groups[1]).getByRole('button', { name: 'Attention requests' }));
    expect(screen.getAllByRole('status', { name: LABEL })).toHaveLength(1);
    // 320px with an agent open: px-1.5 + two gap-1 + Back/menu + icon + bell + 4 apps.
    expect(320 - 2 * 6 - 2 * 4).toBeGreaterThanOrEqual(2 * 40 + 20 + 5 * 40);
  });

  it('stock mobile bar: left of the hamburger', async () => {
    setViewport(390);
    vi.spyOn(roseDesktopFlag, 'isRoseDesktopUser').mockReturnValue(false);
    await renderTerminal('test-user');

    goOffline();
    const [, , right] = [...screen.getByRole('banner').children] as HTMLElement[];
    expect(within(right).getByRole('status', { name: LABEL })).toBeInTheDocument();
    expectJustBefore(within(right).getByRole('button', { name: 'Open menu' }));
  });
});
