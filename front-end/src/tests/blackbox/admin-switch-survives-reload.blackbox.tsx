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

  it('posts agent messages as the switched-into user, not the stashed admin', async () => {
    localStorage.setItem('rose-session', JSON.stringify(session('admin-token', ANDY_ID)));
    await switchToAccount(TARGET_ID);

    let seenAuth: string | null = null;
    server.use(
      http.post(`${API_BASE}/agents/:agentId/messages`, ({ request }) => {
        seenAuth = request.headers.get('authorization');
        return HttpResponse.json({
          id: 'message-1',
          agentId: 'target-agent-1',
          role: 'USER',
          message: 'hello from the switched account',
          createdAt: new Date().toISOString(),
        });
      }),
    );

    const { postMessage } = await import('@/lib/api/messages');
    await postMessage('target-agent-1', 'hello from the switched account');

    expect(seenAuth).toBe('Bearer target-token');
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

/**
 * Stale-async guard. checkNeedsInviteCode() is async, so an invite check started
 * BEFORE a switch can resolve after it and write `false` over the impersonation
 * answer — silently re-trapping the admin the fix above just freed.
 */
describe('a stale invite check cannot re-trap an impersonating admin', () => {
  beforeEach(() => {
    localStorage.clear();
    stubReload();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('ignores an in-flight invite check that resolves after impersonation begins', async () => {
    localStorage.setItem('rose-session', JSON.stringify(session('admin-token', ANDY_ID)));

    // A slow check that reports "needs an invite" and lands AFTER the switch.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(`${API_BASE}/invite-codes/check`, async () => {
        await gate;
        return HttpResponse.json({ needsInviteCode: true });
      }),
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

    const { renderHook } = await import('@testing-library/react');
    const { useAuth } = await import('@/features/auth');
    const { result } = renderHook(() => useAuth({ passive: true }));

    await switchToAccount(TARGET_ID);
    await result.current.refreshAuthState('post-switch');

    // Now let the pre-switch check land; it must not clobber the impersonation answer.
    release?.();

    await waitFor(() => {
      expect(result.current.isFullySignedIn).toBe(true);
    });
  });
});

/**
 * The stuck-forever state actually reported.
 *
 * The Electron main process normalizes `expires_at` to MILLISECONDS and its auth
 * bridge writes that straight into localStorage. Every expiry check here then
 * multiplies by 1000 AGAIN, yielding dates ~57,000 years out — so an expired
 * session looks permanently valid to the client. The server still 401s, so the
 * app sits authenticated-looking, 401-ing on every call, never refreshing, never
 * unwinding the impersonation, and never routing to sign-in. No pill, no escape.
 */
describe('millisecond expires_at from the Electron bridge', () => {
  beforeEach(() => {
    localStorage.clear();
    stubReload();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const msSession = (token: string, userId: string, secondsFromNow: number) => ({
    access_token: token,
    refresh_token: `${token}-refresh`,
    expires_in: 3600,
    // MILLISECONDS, exactly as the Electron bridge persists it.
    expires_at: Date.now() + secondsFromNow * 1000,
    token_type: 'bearer',
    user: { id: userId },
  });

  it('treats an EXPIRED millisecond session as expired instead of valid-for-57000-years', async () => {
    const { getSession } = await import('@/lib/supabase');

    // Expired an hour ago, but written in ms.
    localStorage.setItem('rose-session', JSON.stringify(msSession('dead', TARGET_ID, -3600)));

    // Without normalization this returns the session (ms * 1000 ≈ year 58542).
    expect(getSession()).toBeNull();
  });

  it('repairs a millisecond expires_at in place so the session stops being immortal', async () => {
    const { getSession } = await import('@/lib/supabase');

    localStorage.setItem('rose-session', JSON.stringify(msSession('live', ANDY_ID, 3600)));
    const s = getSession();

    expect(s).not.toBeNull();
    // Persisted back in SECONDS, so later reads and every other expiry check agree.
    const stored = JSON.parse(localStorage.getItem('rose-session') ?? '{}');
    expect(stored.expires_at).toBeLessThan(1e11);
    expect(new Date(stored.expires_at * 1000).getUTCFullYear()).toBe(new Date().getUTCFullYear());
  });

  it('unwinds to the admin when an expired ms impersonated session is detected', async () => {
    const { getSession } = await import('@/lib/supabase');

    localStorage.setItem('rose-session', JSON.stringify(msSession('dead-target', TARGET_ID, -60)));
    localStorage.setItem(
      'rose-admin-session',
      JSON.stringify(msSession('admin-token', ANDY_ID, 7776000)),
    );
    localStorage.setItem(
      'rose-impersonation',
      JSON.stringify({ userId: TARGET_ID, name: null, email: null, phone: null, isAdmin: false }),
    );

    const restored = getSession();

    expect(restored?.access_token).toBe('admin-token');
    expect(localStorage.getItem('rose-impersonation')).toBeNull();
  });
});

/**
 * Persistence-boundary hardening for the millisecond-expiry repair.
 *
 * Three separate ways the repair could still go wrong:
 *   - endImpersonation() wrote the RAW stash back, recreating the mismatch
 *   - a localStorage write failure turned a valid session into a sign-out
 *   - the repair could clobber newer auth state written by another tab
 */
describe('millisecond repair does not corrupt or lose auth state', () => {
  const msSession = (token: string, userId: string, secondsFromNow: number) => ({
    access_token: token,
    refresh_token: `${token}-refresh`,
    expires_in: 3600,
    expires_at: Date.now() + secondsFromNow * 1000, // MILLISECONDS
    token_type: 'bearer',
    user: { id: userId },
  });

  beforeEach(() => {
    localStorage.clear();
    stubReload();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('normalizes the admin session when ending impersonation via the pill', async () => {
    const { endImpersonation } = await import('@/lib/impersonation');

    localStorage.setItem('rose-session', JSON.stringify(msSession('target', TARGET_ID, 60)));
    localStorage.setItem(
      'rose-admin-session',
      JSON.stringify(msSession('admin-token', ANDY_ID, 7776000)),
    );
    localStorage.setItem(
      'rose-impersonation',
      JSON.stringify({ userId: TARGET_ID, name: null, email: null, phone: null, isAdmin: false }),
    );

    expect(endImpersonation()).toBe(true);

    const restored = JSON.parse(localStorage.getItem('rose-session') ?? '{}');
    expect(restored.access_token).toBe('admin-token');
    // Written in SECONDS, so it does not recreate the immortal-session mismatch.
    expect(restored.expires_at).toBeLessThan(1e11);
  });

  it('keeps a valid session when persisting the repair fails', async () => {
    const { getSession } = await import('@/lib/supabase');

    localStorage.setItem('rose-session', JSON.stringify(msSession('live', ANDY_ID, 3600)));
    // Spying on Storage.prototype does NOT intercept jsdom's localStorage, which
    // has its own methods — an earlier version of this test did that and passed
    // even with the guard removed. Replace the instance method instead, and assert
    // the throwing stub was actually reached so the case cannot go vacuous again.
    const realSetItem = window.localStorage.setItem.bind(window.localStorage);
    const throwingSetItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    Object.defineProperty(window.localStorage, 'setItem', {
      configurable: true,
      value: throwingSetItem,
    });

    // A storage failure must not be mistaken for "no session".
    const s = getSession();

    Object.defineProperty(window.localStorage, 'setItem', {
      configurable: true,
      value: realSetItem,
    });

    expect(throwingSetItem).toHaveBeenCalled();
    expect(s?.access_token).toBe('live');
  });

  it('does not resurrect a session when a logout landed during the repair', async () => {
    const { getSession } = await import('@/lib/supabase');

    localStorage.setItem('rose-session', JSON.stringify(msSession('live', ANDY_ID, 3600)));
    localStorage.setItem('rose-session-logout-pending', '1');

    getSession();

    // The repair must not have rewritten SESSION_KEY while a logout was pending.
    const stored = JSON.parse(localStorage.getItem('rose-session') ?? '{}');
    expect(stored.expires_at).toBeGreaterThan(1e11);
  });
});
