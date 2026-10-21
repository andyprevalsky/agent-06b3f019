/**
 * Black-box tests for the always-on admin account switcher.
 *
 * Invariants covered:
 *   - visibility: hidden for non-admins, shown for admins, and STILL shown while
 *     impersonating a non-admin (it holds the only route back)
 *   - the panel always offers both admin accounts for a one-click reset
 *   - search hits GET /admin-health/users and only lists rows with a real userId
 *   - switching stashes the admin session, stores the minted target session, and
 *     reloads; the badge then reads "Viewing as <name>" in purple
 *   - while impersonating, admin-gated calls are signed with the STASHED admin
 *     token, not the target's — otherwise the admin is stranded
 *   - returning restores the admin session and drops both stash keys
 *   - signing out clears the stash, so admin authority can't be resurrected
 *   - Rose Desktop: the flagged account's switcher lives in Settings (inline);
 *     the floating pill only remains as the exit while impersonating
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { AdminAccountSwitcher } from '@/features/admin-account-switcher';
import { AdminSwitcherMount } from '@/features/app-wiring/components/AdminSwitcherMount';
import { clearSession } from '@/lib/supabase';
import * as roseDesktopFlag from '@/lib/roseDesktop';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';
import { ADMIN_ACCOUNTS } from '@/lib/adminAccounts';

const ANDY_ID = ADMIN_ACCOUNTS[0]!.userId;
const TAMY_ID = ADMIN_ACCOUNTS[1]!.userId;

function session(token: string, userId: string) {
  return {
    access_token: token,
    refresh_token: `${token}-refresh`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: userId },
  };
}

function signInAsAdmin() {
  localStorage.setItem('rose-session', JSON.stringify(session('admin-token', ANDY_ID)));
}

function directoryPerson(overrides: Record<string, unknown> = {}) {
  return {
    key: 'user:acct-1',
    userId: 'acct-1',
    waitlistId: null,
    name: 'Grace Hopper',
    email: 'grace@example.com',
    phone: '+12125550188',
    joinedAt: '2026-07-01T00:00:00.000Z',
    invitedAt: null,
    hasAccount: true,
    hasSubscription: false,
    isGated: false,
    isAdmin: false,
    ...overrides,
  };
}

/** Capture reload targets instead of navigating the jsdom document. */
function stubReload() {
  const replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { origin: 'http://localhost:3001', pathname: '/', replace },
  });
  return replace;
}

describe('AdminAccountSwitcher', () => {
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    localStorage.clear();
    signInAsAdmin();
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('is hidden for a non-admin who is not impersonating', () => {
    renderWithProviders(<AdminAccountSwitcher isAdmin={false} ownAccountLabel="+15555550123" />);
    expect(screen.queryByTestId('admin-account-switcher')).toBeNull();
  });

  it('shows the admin their own account and both quick-reset admin chips', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminAccountSwitcher isAdmin ownAccountLabel="+19729777432" />);

    const pill = screen.getByTestId('admin-account-pill');
    expect(pill).toHaveTextContent('+19729777432');
    expect(screen.queryByTestId('admin-impersonation-badge')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Switch account' }));
    expect(await screen.findByRole('dialog', { name: 'Account switcher' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Andy/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Tamy/ })).toBeVisible();
  });

  it('searches the directory and lists only rows with a real account', async () => {
    server.use(
      http.get(`${API_BASE}/admin-health/users`, ({ request }) => {
        const search = new URL(request.url).searchParams.get('search') ?? '';
        return HttpResponse.json({
          people: [
            directoryPerson(),
            // Waitlist-only row: nothing to switch into, must not be offered.
            directoryPerson({ key: 'waitlist:wl-1', userId: null, name: 'Not Signed Up' }),
          ],
          total: 2,
          page: 1,
          pageSize: 20,
          totalPages: 1,
          search,
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AdminAccountSwitcher isAdmin ownAccountLabel="+19729777432" />);
    await user.click(screen.getByRole('button', { name: 'Switch account' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search accounts' }), 'grace');

    expect(await screen.findByText('Grace Hopper')).toBeVisible();
    expect(screen.queryByText('Not Signed Up')).toBeNull();
  });

  it('switches into an account, stashing the admin session and reloading', async () => {
    const replace = stubReload();
    server.use(
      http.post(`${API_BASE}/admin-health/impersonate`, async ({ request }) => {
        const body = (await request.json()) as { userId: string };
        return HttpResponse.json({
          session: session('target-token', body.userId),
          user: {
            userId: body.userId,
            name: 'Tamy',
            email: null,
            phone: '+12028803603',
            isAdmin: true,
          },
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AdminAccountSwitcher isAdmin ownAccountLabel="+19729777432" />);
    await user.click(screen.getByRole('button', { name: 'Switch account' }));
    await user.click(screen.getByRole('button', { name: /Tamy/ }));

    await waitFor(() => expect(replace).toHaveBeenCalled());

    const stashed = JSON.parse(localStorage.getItem('rose-admin-session') ?? 'null');
    expect(stashed.access_token).toBe('admin-token');
    const active = JSON.parse(localStorage.getItem('rose-session') ?? 'null');
    expect(active.access_token).toBe('target-token');
    expect(JSON.parse(localStorage.getItem('rose-impersonation') ?? 'null').userId).toBe(TAMY_ID);
  });

  it('keeps the badge and signs admin calls with the stashed token while impersonating', async () => {
    localStorage.setItem('rose-admin-session', JSON.stringify(session('admin-token', ANDY_ID)));
    localStorage.setItem('rose-session', JSON.stringify(session('target-token', 'acct-1')));
    localStorage.setItem(
      'rose-impersonation',
      JSON.stringify({
        userId: 'acct-1',
        name: 'Grace Hopper',
        email: 'grace@example.com',
        phone: null,
        isAdmin: false,
      }),
    );

    const seenAuth: string[] = [];
    server.use(
      http.get(`${API_BASE}/admin-health/users`, ({ request }) => {
        seenAuth.push(request.headers.get('authorization') ?? '');
        return HttpResponse.json({
          people: [directoryPerson()],
          total: 1,
          page: 1,
          pageSize: 20,
          totalPages: 1,
          search: 'grace',
        });
      }),
    );

    const user = userEvent.setup();
    // isAdmin=false: the impersonated account is NOT an admin, yet the control
    // must remain — it is the only way back to the administrator's session.
    renderWithProviders(<AdminAccountSwitcher isAdmin={false} ownAccountLabel={null} />);

    const badge = screen.getByTestId('admin-impersonation-badge');
    expect(badge).toHaveTextContent('Viewing as Grace Hopper');
    expect(badge.className).toContain('purple');

    await user.click(screen.getByRole('button', { name: 'Switch account' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search accounts' }), 'grace');

    await waitFor(() => expect(seenAuth.length).toBeGreaterThan(0));
    expect(seenAuth.every((header) => header === 'Bearer admin-token')).toBe(true);
  });

  it('returns to the admin account and clears the stash', async () => {
    const replace = stubReload();
    localStorage.setItem('rose-admin-session', JSON.stringify(session('admin-token', ANDY_ID)));
    localStorage.setItem('rose-session', JSON.stringify(session('target-token', 'acct-1')));
    localStorage.setItem(
      'rose-impersonation',
      JSON.stringify({
        userId: 'acct-1',
        name: 'Grace Hopper',
        email: null,
        phone: null,
        isAdmin: false,
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<AdminAccountSwitcher isAdmin={false} ownAccountLabel={null} />);
    await user.click(screen.getByRole('button', { name: 'Return to my account' }));

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem('rose-session') ?? 'null').access_token).toBe(
      'admin-token',
    );
    expect(localStorage.getItem('rose-admin-session')).toBeNull();
    expect(localStorage.getItem('rose-impersonation')).toBeNull();
  });

  it('drops the stashed admin session on sign-out', async () => {
    localStorage.setItem('rose-admin-session', JSON.stringify(session('admin-token', ANDY_ID)));
    localStorage.setItem(
      'rose-impersonation',
      JSON.stringify({ userId: 'acct-1', name: 'Grace', email: null, phone: null, isAdmin: false }),
    );

    await clearSession();

    expect(localStorage.getItem('rose-admin-session')).toBeNull();
    expect(localStorage.getItem('rose-impersonation')).toBeNull();
  });
});

/**
 * Rose Desktop (lib/roseDesktop.ts): the flagged account's switcher lives in the
 * Settings panel, so the top-right corner holds only the 4 bare app icons
 * (FE-13 visual pass). Stock accounts keep the floating pill unchanged, and an
 * impersonating viewer always keeps the floating exit.
 */
describe('AdminSwitcherMount placement (Rose Desktop moves the switcher into Settings)', () => {
  let originalLocation: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location');
    localStorage.clear();
  });

  afterEach(() => {
    if (originalLocation) Object.defineProperty(window, 'location', originalLocation);
    localStorage.clear();
    vi.restoreAllMocks();
  });

  function signIn(userId: string, phone: string) {
    localStorage.setItem(
      'rose-session',
      JSON.stringify({ ...session(`${userId}-token`, userId), user: { id: userId, phone } }),
    );
  }

  function renderBothPlacements() {
    return renderWithProviders(
      <>
        <div data-testid="top-right">
          <AdminSwitcherMount />
        </div>
        <div data-testid="settings">
          <AdminSwitcherMount placement="settings" />
        </div>
      </>,
    );
  }

  it('flagged Andy: no floating pill on his own account; Settings has the inline switcher', async () => {
    signIn(ANDY_ID, '+19729777432');
    renderBothPlacements();
    const inline = await within(screen.getByTestId('settings')).findByTestId(
      'admin-account-switcher',
    );
    expect(inline).toHaveAttribute('data-variant', 'inline');
    expect(
      within(screen.getByTestId('top-right')).queryByTestId('admin-account-switcher'),
    ).toBeNull();
    // Flat, in-flow section: no floating shadow/blur, the panel never positions absolutely.
    const pill = within(inline).getByTestId('admin-account-pill');
    expect(pill).toHaveTextContent('+19729777432');
    expect(pill.className).not.toMatch(/shadow-lg|backdrop-blur-md/);
    expect(pill).toHaveClass('bg-white', 'dark:bg-[#2f2f2c]', 'dark:border-white/[0.09]');
    expect(inline.className).not.toMatch(/(^|\s)(fixed|items-end)(\s|$)/);
  });

  it('the inline switcher is fully functional: quick-switch chips, search and switch', async () => {
    const replace = stubReload();
    server.use(
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json({
          people: [directoryPerson()],
          total: 1,
          page: 1,
          pageSize: 20,
          totalPages: 1,
          search: 'grace',
        }),
      ),
      http.post(`${API_BASE}/admin-health/impersonate`, async ({ request }) => {
        const body = (await request.json()) as { userId: string };
        return HttpResponse.json({
          session: session('target-token', body.userId),
          user: {
            userId: body.userId,
            name: 'Grace Hopper',
            email: null,
            phone: null,
            isAdmin: false,
          },
        });
      }),
    );
    signIn(ANDY_ID, '+19729777432');
    const user = userEvent.setup();
    renderWithProviders(<AdminSwitcherMount placement="settings" />);
    await user.click(await screen.findByRole('button', { name: 'Switch account' }));
    const dialog = screen.getByRole('dialog', { name: 'Account switcher' });
    expect(dialog.className).not.toMatch(/(^|\s)absolute(\s|$)/);
    expect(within(dialog).getByRole('button', { name: /Andy/ })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: /Tamy/ })).toBeVisible();
    await user.type(within(dialog).getByRole('searchbox', { name: 'Search accounts' }), 'grace');
    await user.click(await within(dialog).findByText('Grace Hopper'));

    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(JSON.parse(localStorage.getItem('rose-admin-session') ?? 'null').access_token).toBe(
      `${ANDY_ID}-token`,
    );
    expect(JSON.parse(localStorage.getItem('rose-session') ?? 'null').access_token).toBe(
      'target-token',
    );
  });

  it('an explicit flag-off override preserves the floating admin pill', async () => {
    vi.spyOn(roseDesktopFlag, 'isRoseDesktopUser').mockReturnValue(false);
    signIn(TAMY_ID, '+12028803603');
    renderBothPlacements();
    const floating = await within(screen.getByTestId('top-right')).findByTestId(
      'admin-account-switcher',
    );
    expect(floating).toHaveAttribute('data-variant', 'pill');
    expect(floating.className).toBe('relative flex max-w-full min-w-0 flex-col items-end');
    expect(within(floating).getByTestId('admin-account-pill').className).toBe(
      'flex max-w-full min-w-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-lg backdrop-blur-md transition-colors border-border/60 bg-background/90 text-foreground',
    );
  });

  it('an ordinary admin uses Settings after the all-account rollout', async () => {
    signIn(TAMY_ID, '+12028803603');
    renderBothPlacements();
    const inline = await within(screen.getByTestId('settings')).findByTestId(
      'admin-account-switcher',
    );
    expect(inline).toHaveAttribute('data-variant', 'inline');
    expect(
      within(screen.getByTestId('top-right')).queryByTestId('admin-account-switcher'),
    ).toBeNull();
  });

  it('a flagged account that is being impersonated keeps the floating exit', async () => {
    localStorage.setItem('rose-admin-session', JSON.stringify(session('admin-token', TAMY_ID)));
    signIn(ANDY_ID, '+19729777432');
    localStorage.setItem(
      'rose-impersonation',
      JSON.stringify({ userId: ANDY_ID, name: 'Andy', email: null, phone: null, isAdmin: true }),
    );
    renderBothPlacements();
    const floating = await within(screen.getByTestId('top-right')).findByTestId(
      'admin-impersonation-badge',
    );
    expect(floating).toHaveTextContent('Viewing as Andy');
    expect(
      within(screen.getByTestId('settings')).getByTestId('admin-impersonation-badge'),
    ).toBeVisible();
  });
});
