/**
 * Auth feature — API / data-fetching layer.
 *
 * Sole consumer of auth-related HTTP endpoints within this feature.
 * Hooks call these functions; components never call them directly.
 */

import { storeSession } from '@/lib/supabase';
import type { Session, User } from '@supabase/supabase-js';

import { AUTH_API_BASE_URL } from './config';

// ── Public API ─────────────────────────────────────────────────────────────

/** Send OTP to phone number (E.164 format). */
export async function sendOTP(phone: string): Promise<void> {
  const response = await fetch(`${AUTH_API_BASE_URL}/api/auth/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone }),
  });

  const data: Record<string, unknown> = await response.json();

  if (!response.ok) {
    throw new Error((data.error as string) || 'Failed to send OTP');
  }
}

/**
 * Verify OTP and get session.
 * If anonymousUserId is provided, the backend will merge their agents to the new account.
 */
export async function verifyOTP(
  phone: string,
  token: string,
  anonymousUserId?: string,
  userInfo?: { firstName?: string; lastName?: string },
): Promise<{ user: User; session: Session }> {
  const response = await fetch(`${AUTH_API_BASE_URL}/api/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone,
      token,
      anonymousUserId,
      firstName: userInfo?.firstName,
      lastName: userInfo?.lastName,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Invalid OTP');
  }

  // Build session object
  const session: Session = {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_in: data.session.expires_in,
    expires_at: data.session.expires_at,
    token_type: data.session.token_type || 'bearer',
    user: {
      id: data.user.id,
      phone: data.user.phone || phone,
      is_anonymous: false,
      aud: 'authenticated',
      role: 'authenticated',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      app_metadata: { provider: 'phone', providers: ['phone'] },
      user_metadata: {},
    } as User,
  };

  // Store the session
  storeSession(session);

  console.warn('[Auth] Phone verification complete', { userId: data.user.id });

  return { user: session.user, session };
}
