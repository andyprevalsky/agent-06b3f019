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
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { AdminAccountSwitcher } from '@/features/admin-account-switcher';
import { clearSession } from '@/lib/supabase';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';
const ANDY_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const TAMY_ID = '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9';

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
