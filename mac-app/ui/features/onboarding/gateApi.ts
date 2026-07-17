/**
 * Onboarding gate + subscription API — the calls behind the final onboarding
 * step (OnboardingWaitlist). Split out of api.ts to keep that module focused.
 */

import { getSession } from '@/lib/supabase';
import { getBackendUrl } from './config';
import type { WaitlistStatus } from './types';

const requireToken = (): string => {
  const session = getSession();
  if (session === null || session === undefined || session.access_token === '') {
    throw new Error('Not authenticated');
  }
  return session.access_token;
};

const authHeader = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
});

/**
 * Waitlist gate: whether the user still needs to get in (no code + no active
 * subscription) and whether an admin flagged them off the waitlist (→ subscribe
 * view). Server-side state; survives app relaunches.
 */
export const checkWaitlistStatus = async (): Promise<WaitlistStatus> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/invite-codes/check`, {
    headers: authHeader(token),
  });
  if (!response.ok) {
    throw new Error('Failed to check invite code status');
  }
  const payload = (await response.json()) as { needsInviteCode?: unknown; offWaitlist?: unknown };
  // Fail closed: a malformed response must not coerce needsInviteCode to false
  // and let a gated user straight into the app. Throw so the caller's catch
  // path shows the waitlist view.
  if (typeof payload.needsInviteCode !== 'boolean' || typeof payload.offWaitlist !== 'boolean') {
    throw new Error('Malformed invite-code check response');
  }
  return { needsInviteCode: payload.needsInviteCode, offWaitlist: payload.offWaitlist };
};

/** Mint a Stripe subscription checkout URL for the onboarding subscribe view. */
export const createSubscriptionCheckoutUrl = async (): Promise<string> => {
  const token = requireToken();
  const response = await fetch(`${getBackendUrl()}/api/billing/subscription-checkout`, {
    method: 'POST',
    headers: authHeader(token),
  });
  if (!response.ok) {
    throw new Error('Failed to start subscription checkout');
  }
  const payload = (await response.json()) as { url?: string };
  if (payload.url === undefined || payload.url === '') {
    throw new Error('No checkout URL returned');
  }
  return payload.url;
};
