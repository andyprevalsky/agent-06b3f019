/**
 * Black-box coverage for the onboarding waitlist step (invite gate).
 *
 * Source under test: `mac-app/ui/features/onboarding/components/OnboardingWaitlist.tsx`.
 * On mount it checks GET /api/invite-codes/check: already-in users pass straight
 * through (onComplete); gated users see "You're On The Waitlist!" — or, when an
 * admin flagged them off the waitlist (offWaitlist), the subscribe view. Either
 * view can still redeem a code via POST /api/invite-codes/use, and the subscribe
 * view opens a Stripe checkout via POST /api/billing/subscription-checkout.
 *
 * State-machine sketch:
 *   checking --(needsInviteCode=false)--> onComplete
 *   checking --(needsInviteCode=true & offWaitlist)--> subscribe
 *   checking --(needsInviteCode=true & !offWaitlist | check 5xx)--> waitlist
 *   waitlist/subscribe --(use 200)--> onComplete
 *   waitlist/subscribe --(use 4xx)--> stay (inline server error)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import OnboardingWaitlist from '../../ui/features/onboarding/components/OnboardingWaitlist';

const API_BASE = 'http://localhost:3001/api';
const SESSION_KEY = 'rose-session';

function mockSession() {
  localStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      access_token: 'test-token-abc',
      refresh_token: 'test-refresh-xyz',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'onboarding-user-001' },
    })
  );
}

function gateResponse(needsInviteCode: boolean, offWaitlist = false) {
  server.use(
    http.get(`${API_BASE}/invite-codes/check`, () =>
      HttpResponse.json({ needsInviteCode, offWaitlist })
    )
  );
}

beforeEach(() => {
  clearCaptures();
  localStorage.clear();
  mockSession();
});

afterEach(() => {
  localStorage.clear();
});

describe('OnboardingWaitlist — access check', () => {
  it('completes immediately when the user already has access', async () => {
    gateResponse(false);
    const onComplete = vi.fn();

    renderWithProviders(<OnboardingWaitlist onComplete={onComplete} />);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByText("You're On The Waitlist!")).not.toBeInTheDocument();
  });

  it('shows the waitlist view for a gated user (and keeps showing it on remount)', async () => {
    gateResponse(true);
    const onComplete = vi.fn();

    const { unmount } = renderWithProviders(<OnboardingWaitlist onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText("You're On The Waitlist!")).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /join with invite code/i })).toBeDisabled();
    expect(onComplete).not.toHaveBeenCalled();

    // Relaunch/refresh: server-side state means the gate re-appears
    unmount();
    renderWithProviders(<OnboardingWaitlist onComplete={onComplete} />);
    await waitFor(() => {
      expect(screen.getByText("You're On The Waitlist!")).toBeInTheDocument();
    });
  });

  it('shows the subscribe view when the user was invited off the waitlist', async () => {
    gateResponse(true, true);
    const onComplete = vi.fn();

    renderWithProviders(<OnboardingWaitlist onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText("You're off the waitlist!")).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /^subscribe$/i })).toBeInTheDocument();
    // The invite-code path remains available as an alternative.
    expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    expect(screen.queryByText("You're On The Waitlist!")).not.toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('opens the Stripe checkout URL when Subscribe is clicked', async () => {
    gateResponse(true, true);
    server.use(
      http.post(`${API_BASE}/billing/subscription-checkout`, () =>
        HttpResponse.json({ url: 'https://checkout.stripe.com/c/pay/test-session' })
      )
    );
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();

    renderWithProviders(<OnboardingWaitlist onComplete={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^subscribe$/i })).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: /^subscribe$/i }));

    await waitFor(() => {
      expect(
        capturedRequests.some(
          (r) => r.method === 'POST' && r.url.includes('/billing/subscription-checkout')
        )
      ).toBe(true);
    });
    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        'https://checkout.stripe.com/c/pay/test-session',
        '_blank',
        'noopener,noreferrer'
      );
    });
    openSpy.mockRestore();
  });

  it('fails closed to the waitlist view when the check request errors', async () => {
    server.use(
      http.get(`${API_BASE}/invite-codes/check`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 })
      )
    );
    const onComplete = vi.fn();

    renderWithProviders(<OnboardingWaitlist onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText("You're On The Waitlist!")).toBeInTheDocument();
    });
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('OnboardingWaitlist — invite code redemption', () => {
  it('redeems a valid 6-digit code and completes onboarding', async () => {
    gateResponse(true);
    server.use(
      http.post(`${API_BASE}/invite-codes/use`, () =>
        HttpResponse.json({ success: true, message: 'Invite code accepted' })
      )
    );
    const onComplete = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<OnboardingWaitlist onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText("You're On The Waitlist!")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('000000'), '123456');
    await user.click(screen.getByRole('button', { name: /join with invite code/i }));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    });
    const useReq = capturedRequests.find((r) => r.url.includes('/invite-codes/use'));
    expect(useReq).toBeDefined();
    expect(JSON.parse(useReq!.body ?? '{}')).toEqual({ inviteCode: 123456 });
  });

  it('surfaces the server error for a rejected code and stays on the waitlist', async () => {
    gateResponse(true);
    server.use(
      http.post(`${API_BASE}/invite-codes/use`, () =>
        HttpResponse.json({ error: 'Invalid invite code' }, { status: 404 })
      )
    );
    const onComplete = vi.fn();
    const user = userEvent.setup();

    renderWithProviders(<OnboardingWaitlist onComplete={onComplete} />);

    await waitFor(() => {
      expect(screen.getByText("You're On The Waitlist!")).toBeInTheDocument();
    });

    await user.type(screen.getByPlaceholderText('000000'), '999999');
    await user.click(screen.getByRole('button', { name: /join with invite code/i }));

    await waitFor(() => {
      expect(screen.getByText('Invalid invite code')).toBeInTheDocument();
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText("You're On The Waitlist!")).toBeInTheDocument();
  });

  it('only accepts digits in the code input', async () => {
    gateResponse(true);
    const user = userEvent.setup();

    renderWithProviders(<OnboardingWaitlist onComplete={() => {}} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('000000')).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText('000000');
    await user.type(input, '1a2b3c');
    expect(input).toHaveValue('123');
  });
});
