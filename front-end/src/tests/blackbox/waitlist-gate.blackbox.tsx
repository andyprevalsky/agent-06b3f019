/**
 * Black-box tests for the WaitlistGate component (invite gate for logged-in users).
 *
 * Behavior under test:
 *   - authenticated non-anonymous users with needsInviteCode=true see the
 *     "You're On The Waitlist!" modal (and see it again on every mount/refresh)
 *   - anonymous / signed-out / fully-signed-in users see nothing
 *   - submitting a valid invite code POSTs /invite-codes/use and dismisses the
 *     gate once the server reports needsInviteCode=false
 *   - server rejections surface inline and keep the gate up
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import { WaitlistGate } from '@/features/auth';

const API_BASE = 'http://localhost:3001/api';

// Session keys used by supabase.ts
const SESSION_KEY = 'rose-session';
const USER_CACHE_KEY = 'app-user';

function mockSession(opts: { anonymous?: boolean } = {}) {
  const session = {
    access_token: 'test-token-abc',
    refresh_token: 'test-refresh-xyz',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: {
      id: 'waitlist-user-001',
      phone: '+525512345678',
      is_anonymous: opts.anonymous ?? false,
      aud: 'authenticated',
      role: 'authenticated',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      app_metadata: opts.anonymous
        ? { provider: 'anonymous', providers: ['anonymous'] }
        : { provider: 'phone', providers: ['phone'] },
      user_metadata: {},
    },
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  localStorage.setItem(USER_CACHE_KEY, JSON.stringify(session.user));
  return session;
}

/** Make GET /invite-codes/check report the user as gated. */
function gateOn() {
  server.use(
    http.get(`${API_BASE}/invite-codes/check`, () => HttpResponse.json({ needsInviteCode: true })),
  );
}

describe('WaitlistGate', () => {
  beforeEach(() => {
    clearCaptures();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('shows the waitlist modal for a gated authenticated user', async () => {
    mockSession();
    gateOn();

    renderWithProviders(<WaitlistGate />);

    await waitFor(() => {
      expect(screen.getByText("You're On The Waitlist!")).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Invite code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join with invite code/i })).toBeDisabled();
  });

  it('renders nothing for a fully signed-in user (needsInviteCode=false)', async () => {
    mockSession();
    // Default MSW handler returns needsInviteCode: false

    renderWithProviders(<WaitlistGate />);

    await waitFor(() => {
      const checkReq = capturedRequests.find((r) => r.url.includes('/invite-codes/check'));
      expect(checkReq).toBeDefined();
    });
    expect(screen.queryByText("You're On The Waitlist!")).not.toBeInTheDocument();
  });

  it('renders nothing for an anonymous user', async () => {
    mockSession({ anonymous: true });
    gateOn();

    const { container } = renderWithProviders(<WaitlistGate />);

    // Give the auth hook time to settle; anonymous users are never gated here
    await waitFor(() => {
      expect(container.textContent).not.toContain("You're On The Waitlist!");
    });
  });

  it('renders nothing on /test_payment even when the session is waitlisted', async () => {
    mockSession();
    gateOn();

    const { container } = renderWithProviders(<WaitlistGate />, { route: '/test_payment' });

    await waitFor(() => {
      expect(container.textContent).not.toContain("You're On The Waitlist!");
    });
    expect(screen.queryByLabelText('Invite code')).not.toBeInTheDocument();
  });

  it('redeems a valid invite code and dismisses the gate', async () => {
    mockSession();
    let redeemed = false;
    server.use(
      http.get(`${API_BASE}/invite-codes/check`, () =>
        HttpResponse.json({ needsInviteCode: !redeemed }),
      ),
      http.post(`${API_BASE}/invite-codes/use`, () => {
        redeemed = true;
        return HttpResponse.json({ success: true, message: 'Invite code accepted' });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<WaitlistGate />);

    await waitFor(() => {
      expect(screen.getByText("You're On The Waitlist!")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Invite code'), '123456');
    await user.click(screen.getByRole('button', { name: /join with invite code/i }));

    await waitFor(() => {
      const useReq = capturedRequests.find((r) => r.url.includes('/invite-codes/use'));
      expect(useReq).toBeDefined();
      expect(useReq!.body).toEqual({ inviteCode: 123456 });
    });

    // Gate re-checks and dismisses
    await waitFor(() => {
      expect(screen.queryByText("You're On The Waitlist!")).not.toBeInTheDocument();
    });
  });

  it('shows the server error inline for an invalid code and keeps the gate up', async () => {
    mockSession();
    gateOn();
    server.use(
      http.post(`${API_BASE}/invite-codes/use`, () =>
        HttpResponse.json({ error: 'Invalid invite code' }, { status: 404 }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<WaitlistGate />);

    await waitFor(() => {
      expect(screen.getByText("You're On The Waitlist!")).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText('Invite code'), '999999');
    await user.click(screen.getByRole('button', { name: /join with invite code/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid invite code')).toBeInTheDocument();
    });
    expect(screen.getByText("You're On The Waitlist!")).toBeInTheDocument();
  });

  it('offers a sign-out escape hatch', async () => {
    mockSession();
    gateOn();

    renderWithProviders(<WaitlistGate />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    });
  });
});
