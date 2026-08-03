/**
 * Service layer for the auth domain.
 *
 * Business logic orchestration over the persisted session blob:
 *   - getSession(): read + normalize + proactively refresh within the
 *     pre-expiry buffer, clear the session when a refresh for an already
 *     expired token fails.
 *   - setSession(): normalize (seconds -> ms) then persist. A session whose
 *     expires_at is null/0 is treated as a clearSession.
 *   - clearSession(): wipe the persisted blob.
 *
 * All local state goes through repo.ts; the Supabase refresh-token endpoint
 * is called directly via fetch (the only cross-process boundary this layer
 * owns).
 */

import { config } from '../../base/config';
import { MILLISECOND_THRESHOLD, REFRESH_BUFFER_MS } from './config';
import { accessTokenIsImpersonated } from './impersonation';
import { deleteSession, readSession, writeSession } from './repo';
import type { AuthSession, SupabaseTokenResponse } from './types';

const LOG_COMPONENT = '[AuthService]';

/**
 * Convert an `expires_at` value to milliseconds. Values below
 * `MILLISECOND_THRESHOLD` are assumed to be seconds-precision and scaled up.
 * Null/zero values return null so callers can skip the refresh check.
 */
function toMillis(value: number | undefined | null): number | null {
  if (value === undefined || value === null || value === 0) return null;
  return value < MILLISECOND_THRESHOLD ? value * 1000 : value;
}

/**
 * Normalize the `expires_at` field on a session so it's always in ms.
 * Returns the input reference unchanged when no normalization is needed — the
 * reference-equality result lets `getSession` decide whether to re-persist.
 */
function normalizeSession(session: AuthSession | null | undefined): AuthSession | null {
  if (session === null || session === undefined) return null;
  const expiresAtMs = toMillis(session.expires_at);
  if (expiresAtMs === null) return session;
  if (expiresAtMs === session.expires_at) return session;
  return {
    ...session,
    expires_at: expiresAtMs,
  };
}

/**
 * Exchange a stored refresh token for a new session via Supabase's
 * `/auth/v1/token?grant_type=refresh_token` endpoint. Persists the new
 * session on success. Returns null on any non-2xx response or network error.
 */
async function refreshToken(refreshTokenValue: string): Promise<AuthSession | null> {
  try {
    const response = await fetch(`${config.supabase.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: config.supabase.anonKey,
      },
      body: JSON.stringify({ refresh_token: refreshTokenValue }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`${LOG_COMPONENT} Token refresh failed:`, response.status, errorText);
      return null;
    }

    const data = (await response.json()) as SupabaseTokenResponse;

    // Supabase returns expires_in (seconds); convert to an absolute ms timestamp.
    const newSession: AuthSession = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
      user: data.user,
    };

    setSession(newSession);
    console.log(`${LOG_COMPONENT} ✅ Token refreshed successfully`);
    return newSession;
  } catch (error) {
    console.error(`${LOG_COMPONENT} Token refresh error:`, error);
    return null;
  }
}

/**
 * Read the persisted session and return it, auto-normalizing legacy
 * seconds-precision expires_at values and transparently refreshing when the
 * token is expired or within the pre-expiry buffer.
 */
export async function getSession(): Promise<AuthSession | null> {
  const stored = readSession();
  const session = normalizeSession(stored);
  if (!session) return null;

  // Self-heal: a legacy seconds-precision stored value got rewritten in-memory;
  // persist the normalized version so subsequent reads don't re-normalize.
  if (session !== stored) {
    writeSession(session);
  }

  // Impersonated sessions are deliberately one-hour, non-renewable operator
  // tools. Refreshing one through the generic Supabase path can replace its
  // server-signed `act` claim with an ordinary target-user token, erasing the
  // only main-process signal that blocks cross-account machine-data sync.
  if (accessTokenIsImpersonated(session.access_token)) {
    if (Date.now() >= session.expires_at) {
      clearSession();
      return null;
    }
    return session;
  }

  // If expired or about to expire, attempt a refresh before returning.
  if (Date.now() >= session.expires_at - REFRESH_BUFFER_MS) {
    console.log(`${LOG_COMPONENT} Token expired or expiring soon, attempting refresh...`);
    const refreshed = await refreshToken(session.refresh_token);
    if (refreshed) {
      return refreshed;
    }
    // Refresh failed. Only wipe the session if the token is actually past
    // expiry — otherwise the caller still has a usable (if short-lived) token.
    if (Date.now() >= session.expires_at) {
      clearSession();
      return null;
    }
  }

  return session;
}

/**
 * Persist a session, normalizing its `expires_at` to milliseconds first.
 * A session whose expires_at normalizes to null is treated as a
 * `clearSession` call for robustness.
 */
export function setSession(session: AuthSession): void {
  const normalized = normalizeSession(session);
  if (!normalized) {
    clearSession();
    return;
  }
  writeSession(normalized);
}

/** Wipe any persisted session blob. Safe to call when no session is stored. */
export function clearSession(): void {
  deleteSession();
}
