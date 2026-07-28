/**
 * Black-box repro for the reported bug: after an admin switches into another
 * account, the omnipresent switcher pill disappears AND admin-gated views become
 * unreachable — with no way back.
 *
 * The earlier fix only covered session EXPIRY. This exercises the path the user
 * actually hits: switch, then a FRESH page load (the switch does a hard reload),
 * which is where AdminSwitcherMount re-derives `isAdmin` from the now-target
 * identity.
 *
 * Invariants:
 *   - after switching + reload, the pill is still rendered (it is the only exit)
 *   - after switching + reload, admin-gated calls still carry the STASHED admin
 *     token, so admin views remain reachable
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { AdminSwitcherMount } from '@/features/app-wiring/components/AdminSwitcherMount';
import { switchToAccount, fetchAdminDirectory } from '@/lib/adminUsers';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

const API_BASE = 'http://localhost:3001/api';
const ANDY_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const TARGET_ID = 'target-user-1';

function session(token: string, userId: string, phone = '') {
  return {
    access_token: token,
    refresh_token: `${token}-refresh`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: userId, phone },
  };
}

/** The hard reload switchToAccount performs is a no-op in jsdom; assert on state. */
function stubReload() {
  const replace = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, origin: 'http://localhost', pathname: '/', replace },
  });
  return replace;
}

describe('admin switch survives the post-switch reload', () => {
  beforeEach(() => {
    localStorage.clear();
    stubReload();
    server.use(
      http.post(`${API_BASE}/admin-health/impersonate`, () =>
        HttpResponse.json({
          session: session('target-token', TARGET_ID, '+12125550100'),
          user: {
            userId: TARGET_ID,
            name: 'Switched Target',
            email: null,
            phone: '+12125550100',
            isAdmin: false,
          },
        }),
      ),
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json({ people: [], total: 0, page: 1, pageSize: 25 }),
      ),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('keeps the switcher pill after switching into a non-admin account', async () => {
    localStorage.setItem('rose-session', JSON.stringify(session('admin-token', ANDY_ID)));

    await switchToAccount(TARGET_ID);

    // Simulate the hard reload: a brand-new mount reading only localStorage.
    renderWithProviders(<AdminSwitcherMount />);

    await waitFor(() => {
      expect(screen.getByTestId('admin-account-switcher')).toBeInTheDocument();
    });
    expect(screen.getByText(/Viewing as/i)).toBeInTheDocument();
  });

  it('keeps admin-gated calls signed with the stashed admin token after the switch', async () => {
    localStorage.setItem('rose-session', JSON.stringify(session('admin-token', ANDY_ID)));

    await switchToAccount(TARGET_ID);

    // The active session is now the target's; admin calls must NOT use it.
    expect(JSON.parse(localStorage.getItem('rose-session') ?? '{}').access_token).toBe(
      'target-token',
    );

    let seenAuth: string | null = null;
    server.use(
      http.get(`${API_BASE}/admin-health/users`, ({ request }) => {
        seenAuth = request.headers.get('authorization');
        return HttpResponse.json({ people: [], total: 0, page: 1, pageSize: 25 });
      }),
    );

    await fetchAdminDirectory({ search: 'x', page: 1, pageSize: 25 });

    expect(seenAuth).toBe('Bearer admin-token');
  });
});

/**
 * The reported failure. Switching into an account WITHOUT a redeemed invite code
 * makes checkNeedsInviteCode() true for the impersonated identity, so WaitlistGate
 * opens its modal over the whole app: the switcher pill becomes unreachable, admin
 * views are covered, and the terminal cannot be used to message the agent.
 *
 * An admin inspecting an account is not a user signing up — the gate must not
 * apply while impersonating.
 */
describe('waitlist gate must not trap an impersonating admin', () => {
  beforeEach(() => {
    localStorage.clear();
    stubReload();
    server.use(
      http.post(`${API_BASE}/admin-health/impersonate`, () =>
        HttpResponse.json({
          session: session('target-token', TARGET_ID, '+12125550100'),
          user: {
            userId: TARGET_ID,
            name: 'Gated Target',
            email: null,
            phone: '+12125550100',
            isAdmin: false,
          },
        }),
      ),
      // The switched-into account has never redeemed an invite code.
      http.get(`${API_BASE}/invite-codes/check`, () =>
        HttpResponse.json({ needsInviteCode: true }),
      ),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('does not show the waitlist modal while an admin is impersonating', async () => {
    localStorage.setItem('rose-session', JSON.stringify(session('admin-token', ANDY_ID)));
    await switchToAccount(TARGET_ID);

    const { WaitlistGate } = await import('@/features/auth');
    renderWithProviders(
      <>
        <WaitlistGate />
        <AdminSwitcherMount />
      </>,
    );

    // The pill is the only way back and must stay present.
    await waitFor(() => {
      expect(screen.getByTestId('admin-account-switcher')).toBeInTheDocument();
    });

    // The gate must stay closed: an impersonating admin is not a waitlisted user.
    await waitFor(() => {
      expect(screen.queryByText(/You're On The Waitlist/i)).not.toBeInTheDocument();
    });
  });
});

/**
 * The "can't send messages to the agent I switched into" symptom.
 *
 * isFullySignedIn is the app-wide capability flag: useMessageSending refuses to
 * send while it is false, useTerminalAgents refuses to submit goals, and Terminal
 * renders with a null user. It was derived from the IMPERSONATED account's invite
 * status, so switching into any not-yet-invited account disabled the product for
 * the operator.
 */
describe('an impersonating admin can still use the app', () => {
  beforeEach(() => {
    localStorage.clear();
    stubReload();
    server.use(
      http.post(`${API_BASE}/admin-health/impersonate`, () =>
        HttpResponse.json({
          session: session('target-token', TARGET_ID, '+12125550100'),
          user: {
            userId: TARGET_ID,
            name: 'Gated Target',
            email: null,
            phone: '+12125550100',
            isAdmin: false,
          },
        }),
      ),
      http.get(`${API_BASE}/invite-codes/check`, () =>
        HttpResponse.json({ needsInviteCode: true }),
      ),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('reports isFullySignedIn while impersonating a not-yet-invited account', async () => {
    localStorage.setItem('rose-session', JSON.stringify(session('admin-token', ANDY_ID)));
    await switchToAccount(TARGET_ID);

    const { renderHook } = await import('@testing-library/react');
    const { useAuth } = await import('@/features/auth');

    const { result } = renderHook(() => useAuth({ passive: true }));

    await waitFor(() => {
      expect(result.current.isFullySignedIn).toBe(true);
    });
  });
});

/**
 * "I should STILL see Benchmarks and Health after switching."
 *
 * Both surfaces were gated on the IMPERSONATED identity, so they vanished the
 * moment an admin switched into a non-admin — and even if shown, their API calls
 * were signed with the target's session, which the backend admin gate rejects.
 */
describe('admin surfaces survive an account switch', () => {
  beforeEach(() => {
    localStorage.clear();
    stubReload();
    server.use(
      http.post(`${API_BASE}/admin-health/impersonate`, () =>
        HttpResponse.json({
          session: session('target-token', TARGET_ID, '+12125550100'),
          user: {
            userId: TARGET_ID,
            name: 'Gated Target',
            email: null,
            phone: '+12125550100',
            isAdmin: false,
          },
        }),
      ),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('still treats the operator as an admin for Health/Benchmarks visibility', async () => {
    localStorage.setItem('rose-session', JSON.stringify(session('admin-token', ANDY_ID)));
    await switchToAccount(TARGET_ID);

    const { isAdminOperator } = await import('@/lib/adminAccounts');

    // The signed-in identity is now a non-admin, yet the operator is still an admin.
    expect(isAdminOperator({ id: TARGET_ID, phone: '+12125550100' })).toBe(true);
  });

  it('signs admin-health calls with the stashed admin token while impersonating', async () => {
    localStorage.setItem('rose-session', JSON.stringify(session('admin-token', ANDY_ID)));
    await switchToAccount(TARGET_ID);

    let seenAuth: string | null = null;
    server.use(
      http.get(`${API_BASE}/admin-health`, ({ request }) => {
        seenAuth = request.headers.get('authorization');
        return HttpResponse.json({ timeSlice: 'weekly', series: [], summary: {} });
      }),
    );

    const { fetchAdminHealthData } = await import('@/features/admin-health/api');
    await fetchAdminHealthData('weekly').catch(() => undefined);

    expect(seenAuth).toBe('Bearer admin-token');
  });
});
