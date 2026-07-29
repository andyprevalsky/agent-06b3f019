/**
 * Admin account switching (impersonation) — client-side session custody.
 *
 * STATE MACHINE
 *
 *   [OWN ACCOUNT]
 *     -- beginImpersonation(target, session) -->
 *        stash the admin session under ADMIN_SESSION_KEY (only on the FIRST
 *        hop, so switching A→B→C still restores A), write the target identity,
 *        then storeSession(target)
 *   [IMPERSONATING]
 *     -- beginImpersonation(other) --> [IMPERSONATING] (admin stash untouched)
 *     -- endImpersonation() -------->  restore the stashed admin session,
 *                                      drop both keys -> [OWN ACCOUNT]
 *     -- admin session expired ----->  endImpersonation() returns false and
 *                                      clears the badge; the app falls back to
 *                                      the normal signed-out flow
 *
 * The backend never learns a session is an impersonation — it mints an ordinary
 * user session (POST /api/admin-health/impersonate, admin-gated). Reversibility
 * lives entirely here: the admin's own session is retained, never destroyed.
 */

import type { Session } from '@supabase/supabase-js';

import {
  ADMIN_SESSION_KEY,
  getStoredSession,
  IMPERSONATION_KEY,
  notifyImpersonationChanged,
  storeSession,
  normalizeSessionExpiry,
} from './supabase';

/** Fired whenever the impersonation state changes, so every mount re-reads it. */
export { IMPERSONATION_CHANGED_EVENT, clearImpersonationState } from './supabase';

export interface ImpersonatedAccount {
  userId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  isAdmin: boolean;
}

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(key);
  if (stored === null) return null;
  try {
    return JSON.parse(stored) as T;
  } catch {
    window.localStorage.removeItem(key);
    return null;
  }
}

/** Whether a stashed session can no longer be restored. */
function isSessionExpired(session: Session | null): boolean {
  if (session === null || typeof session.expires_at !== 'number') return false;
  // Normalize first: the Electron bridge persists expires_at in MILLISECONDS, and
  // an unnormalized ms value multiplied by 1000 lands ~57,000 years out, so a
  // dead stash would look permanently valid and the admin could never be unwound.
  const { expires_at: expiresAt } = normalizeSessionExpiry(session);
  return typeof expiresAt === 'number' && expiresAt * 1000 < Date.now();
}

/** The account currently being impersonated, or null when on the admin's own account. */
export function getImpersonatedAccount(): ImpersonatedAccount | null {
  const account = readJson<ImpersonatedAccount>(IMPERSONATION_KEY);
  if (account === null || typeof account.userId !== 'string' || account.userId === '') return null;
  // A stashed admin session is what makes the switch reversible. Without one —
  // or with an EXPIRED one — we are not in a recoverable impersonation, so don't
  // claim to be. An expired stash would otherwise keep signing admin-gated calls
  // with a dead token and surface generic failures instead of a clear expiry.
  const adminSession = readJson<Session>(ADMIN_SESSION_KEY);
  if (adminSession === null || isSessionExpired(adminSession)) {
    window.localStorage.removeItem(IMPERSONATION_KEY);
    window.localStorage.removeItem(ADMIN_SESSION_KEY);
    return null;
  }
  return account;
}

export function isImpersonating(): boolean {
  return getImpersonatedAccount() !== null;
}

/**
 * The access token that carries ADMIN authority right now.
 *
 * While impersonating, the active session belongs to a (possibly non-admin)
 * target, so admin-gated calls — searching the directory, switching again — must
 * be signed with the stashed administrator session instead. Returns null when
 * nothing is signed in.
 */
export function getAdminAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  if (getImpersonatedAccount() !== null) {
    const adminSession = readJson<Session>(ADMIN_SESSION_KEY);
    if (adminSession?.access_token) return adminSession.access_token;
  }
  return getStoredSession()?.access_token ?? null;
}

/**
 * Switch into `account` using an already-minted session.
 *
 * The admin's own session is stashed only when this is the first hop, so a
 * chain of switches always unwinds back to the real administrator rather than
 * to whichever account was visited most recently.
 */
export function beginImpersonation(account: ImpersonatedAccount, session: Session): void {
  if (typeof window === 'undefined') return;

  if (window.localStorage.getItem(ADMIN_SESSION_KEY) === null) {
    const adminSession = getStoredSession();
    if (adminSession === null) {
      throw new Error('Cannot switch accounts without a signed-in admin session');
    }
    window.localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(adminSession));
  }

  window.localStorage.setItem(IMPERSONATION_KEY, JSON.stringify(account));
  storeSession(session);
  notifyImpersonationChanged();
}

/**
 * Restore the administrator's own session.
 *
 * Returns false when there is nothing to restore or the stashed session has
 * expired — the caller should send the user through a normal sign-in rather
 * than leaving a badge pointing at an account it can no longer leave.
 */
export function endImpersonation(): boolean {
  if (typeof window === 'undefined') return false;

  const adminSession = readJson<Session>(ADMIN_SESSION_KEY);
  window.localStorage.removeItem(ADMIN_SESSION_KEY);
  window.localStorage.removeItem(IMPERSONATION_KEY);

  if (adminSession === null || isSessionExpired(adminSession)) {
    notifyImpersonationChanged();
    return false;
  }

  // Persist NORMALIZED: isSessionExpired() only normalized a throwaway clone, so
  // handing the raw stash to storeSession() would write a legacy millisecond
  // expires_at back into SESSION_KEY and recreate the immortal-session mismatch.
  storeSession(normalizeSessionExpiry(adminSession));
  notifyImpersonationChanged();
  return true;
}
