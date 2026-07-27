/**
 * Supabase Client & Auth Helpers
 *
 * Simple phone-based auth. Sessions are stored in localStorage after
 * phone OTP verification. The Supabase client is only used for realtime.
 */

import { createClient, type Session, type User } from '@supabase/supabase-js';
import { BACKEND_BASE_URL } from './backendUrl';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

// Storage keys
const SESSION_KEY = 'rose-session';
const USER_CACHE_KEY = 'app-user';
const LOGOUT_EPOCH_KEY = 'rose-session-logout-epoch';
const LOGOUT_PENDING_KEY = 'rose-session-logout-pending';
export const AUTH_SESSION_CHANGED_EVENT = 'rose-auth-session-changed';

// Admin account switching (see lib/impersonation.ts). The keys live here — with
// every other session key — so clearSession() can drop them without importing
// impersonation.ts, which imports this module.
export const ADMIN_SESSION_KEY = 'rose-admin-session';
export const IMPERSONATION_KEY = 'rose-impersonation';
export const IMPERSONATION_CHANGED_EVENT = 'rose-impersonation-changed';

function notifyAuthSessionChanged(): void {
  window.dispatchEvent(new CustomEvent(AUTH_SESSION_CHANGED_EVENT));
}

export function notifyImpersonationChanged(): void {
  window.dispatchEvent(new CustomEvent(IMPERSONATION_CHANGED_EVENT));
}

/**
 * Drop impersonation bookkeeping without restoring anything. Signing out must
 * do this: a stashed admin session left behind would resurrect an "impersonating"
 * badge — and admin authority — on the next load, after the admin logged out.
 */
export function clearImpersonationState(): void {
  if (typeof window === 'undefined') return;
  const hadState =
    window.localStorage.getItem(ADMIN_SESSION_KEY) !== null ||
    window.localStorage.getItem(IMPERSONATION_KEY) !== null;
  window.localStorage.removeItem(ADMIN_SESSION_KEY);
  window.localStorage.removeItem(IMPERSONATION_KEY);
  if (hadState) notifyImpersonationChanged();
}

// API Configuration
const API_BASE_URL = BACKEND_BASE_URL;

// =============================================================================
// Clear stale Supabase auth keys on load
// These can interfere with our custom session management
// =============================================================================

if (typeof window !== 'undefined') {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('sb-') && key.endsWith('-auth-token')) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach((key) => {
    console.log(`[Supabase] Clearing stale auth key: ${key}`);
    localStorage.removeItem(key);
  });
}

// =============================================================================
// Supabase Client (for realtime only)
// =============================================================================

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  // CRITICAL: Top-level accessToken callback for third-party auth.
  // This is called by Supabase internally for ALL operations (Data API, Realtime, Storage, etc.)
  // Without this, Supabase uses the anon key which breaks private channels.
  // See: https://supabase.com/docs/guides/auth/third-party/auth0
  accessToken: async () => {
    const stored = window.localStorage.getItem(SESSION_KEY);
    if (!stored) {
      console.log('[Supabase] accessToken callback: no session');
      return null;
    }
    try {
      const session = JSON.parse(stored);
      if (session?.access_token) {
        return session.access_token;
      }
    } catch {
      console.error('[Supabase] accessToken callback: failed to parse session');
    }
    return null;
  },
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
  realtime: {
    params: {
      eventsPerSecond: 30,
    },
  },
});

// =============================================================================
// Session Management
// =============================================================================

/**
 * Get the current session from localStorage.
 * Returns null if no session exists or if expired.
 */
export function getSession(): Session | null {
  if (typeof window === 'undefined') return null;

  // For Electron, check auth bridge first
  // Note: This is sync, so we can't await. The session should be primed on app start.

  const stored = window.localStorage.getItem(SESSION_KEY);
  if (!stored) return null;

  try {
    const session = JSON.parse(stored) as Session;

    // Check if expired
    if (session.expires_at && session.expires_at * 1000 < Date.now()) {
      console.log('[Supabase] Session expired, clearing');
      clearSession();
      return null;
    }

    return session;
  } catch (error) {
    console.warn('[Supabase] Failed to parse session', error);
    return null;
  }
}

/**
 * Store a session in localStorage (and Electron auth bridge if available).
 */
export function storeSession(session: Session): void {
  if (typeof window === 'undefined') return;

  console.log('[Supabase] Storing session', { userId: session.user?.id });

  const isAnonymousSession = isAnonymousUser(session.user);
  if (!isAnonymousSession) {
    window.localStorage.removeItem(LOGOUT_PENDING_KEY);
  }

  // Store in localStorage
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));

  // For Electron, persist only real signed-in sessions. Anonymous sessions are
  // renderer bootstrap state; saving them to the main-process auth store makes
  // refresh-after-logout look authenticated again.
  if (window.api?.auth && !isAnonymousSession) {
    window.api.auth.save(session).catch((error: unknown) => {
      console.warn('[Supabase] Failed to save to Electron auth bridge', error);
    });
  }

  // Cache the user
  if (session.user) {
    persistCachedUser(session.user);
  }

  notifyAuthSessionChanged();
}

/**
 * Clear the session from all storage.
 */
export async function clearSession(): Promise<void> {
  if (typeof window === 'undefined') return;

  console.log('[Supabase] Clearing session');

  window.localStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem(USER_CACHE_KEY);
  clearImpersonationState();
  const nextLogoutEpoch = Number(window.localStorage.getItem(LOGOUT_EPOCH_KEY) ?? '0') + 1;
  window.localStorage.setItem(LOGOUT_EPOCH_KEY, String(nextLogoutEpoch));
  window.localStorage.setItem(LOGOUT_PENDING_KEY, '1');
  notifyAuthSessionChanged();

  // For Electron, also clear auth bridge
  if (window.api?.auth) {
    let clearedElectronStore = false;
    try {
      await window.api.auth.clear();
      clearedElectronStore = true;
    } finally {
      if (
        clearedElectronStore &&
        window.localStorage.getItem(LOGOUT_EPOCH_KEY) === String(nextLogoutEpoch)
      ) {
        window.localStorage.removeItem(LOGOUT_PENDING_KEY);
      }
    }
  } else {
    window.localStorage.removeItem(LOGOUT_PENDING_KEY);
  }
}

/**
 * Check if a session exists.
 */
export function hasSession(): boolean {
  return getSession() !== null;
}

// =============================================================================
// User Cache
// =============================================================================

export function persistCachedUser(user: User | null): void {
  if (typeof window === 'undefined') return;
  if (user) {
    window.localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
  } else {
    window.localStorage.removeItem(USER_CACHE_KEY);
  }
}

export function getCachedUser(): User | null {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(USER_CACHE_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

// =============================================================================
// Anonymous Auth (via Backend)
// =============================================================================

/**
 * Create an anonymous session for users who haven't signed in yet.
 */
export async function createAnonymousSession(): Promise<{ user: User; session: Session }> {
  const response = await fetch(`${API_BASE_URL}/api/auth/anonymous`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Failed to create anonymous session');
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
      is_anonymous: true,
      aud: 'authenticated',
      role: 'authenticated',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      app_metadata: { provider: 'anonymous', providers: ['anonymous'] },
      user_metadata: {},
    } as User,
  };

  // Store the session
  storeSession(session);

  console.log('[Supabase] Anonymous session created', { userId: data.user.id });

  return { user: session.user, session };
}

// =============================================================================
// Phone Auth (via Backend)
// =============================================================================
// NOTE: sendOTP and verifyOTP have been moved to features/auth/api.ts.
// Mac-app imports them directly from '@/features/auth/api'.

/**
 * Sign out - just clears the session.
 */
export async function signOut(): Promise<void> {
  await clearSession();
}

// =============================================================================
// Realtime Auth - SINGLE SOURCE OF TRUTH
// =============================================================================

let realtimeInitialized = false;
// The exact token last bound onto the realtime socket. autoRefreshToken is off
// (line above), so the socket keeps whatever token setRealtimeAuth last pinned;
// if the persisted session rotated since then, a private-channel join (agent:<id>)
// signs with a STALE token and the server rejects it as Unauthorized. We track the
// bound token so subscribers can re-bind the current session token before joining.
let lastBoundRealtimeToken: string | null = null;

/**
 * Helper to identify token type for logging
 */
function identifyToken(token: string | null): string {
  if (!token) return 'null';
  if (token.length < 50) return 'invalid (too short)';

  try {
    // Decode JWT payload (middle part)
    const parts = token.split('.');
    if (parts.length !== 3) return 'invalid (not JWT)';

    const payload = JSON.parse(atob(parts[1]));

    // Check if it's the anon key (has role: "anon" or no sub claim)
    if (payload.role === 'anon') {
      return 'ANON_KEY ⚠️';
    }

    // Check if it's a user token
    if (payload.sub && payload.role === 'authenticated') {
      return `USER_JWT (sub: ${payload.sub.slice(0, 8)}...)`;
    }

    return `unknown (role: ${payload.role}, sub: ${payload.sub ? 'yes' : 'no'})`;
  } catch {
    return 'invalid (decode failed)';
  }
}

/**
 * Set the realtime auth token. This is the ONLY place setAuth should be called.
 * Called by useAuth when session changes.
 */
export async function setRealtimeAuth(accessToken: string | null): Promise<void> {
  const tokenType = identifyToken(accessToken);
  const stack = new Error().stack?.split('\n').slice(2, 5).join('\n') || 'no stack';

  console.log(`[Supabase] setRealtimeAuth called with: ${tokenType}`);
  console.log(`[Supabase] Call stack:\n${stack}`);

  if (accessToken) {
    await supabase.realtime.setAuth(accessToken);
    realtimeInitialized = true;
    lastBoundRealtimeToken = accessToken;
    console.log(`[Supabase] ✅ Realtime auth set to: ${tokenType}`);
  } else {
    console.log('[Supabase] Clearing realtime auth (no token)');
    realtimeInitialized = false;
    lastBoundRealtimeToken = null;
  }
}

/**
 * Ensure the realtime socket is signing joins with the CURRENT session token.
 * Rebinds only when the persisted session token differs from what was last bound
 * (or nothing is bound yet), so private-channel joins never sign with a stale
 * token — the root cause of intermittent `agent:<id>` "Unauthorized" rejections —
 * while a no-op re-bind of the same token is skipped to avoid socket churn.
 */
export async function ensureFreshRealtimeAuth(): Promise<void> {
  const token = getSession()?.access_token ?? null;
  if (token && token !== lastBoundRealtimeToken) {
    await setRealtimeAuth(token);
  }
}

/**
 * Check if realtime auth has been initialized.
 */
export function isRealtimeReady(): boolean {
  return realtimeInitialized;
}

/**
 * @deprecated Use setRealtimeAuth instead. This is kept for backwards compatibility.
 */
export async function initializeRealtime(): Promise<void> {
  const session = getSession();
  if (session?.access_token) {
    await setRealtimeAuth(session.access_token);
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if a user is anonymous.
 */
export function isAnonymousUser(user: User | null): boolean {
  return user?.is_anonymous === true;
}

// Legacy exports for compatibility
export const getStoredSession = getSession;
export const clearStoredSession = clearSession;

let electronAuthBridgePrimed: Promise<void> = Promise.resolve();

export function waitForElectronAuthBridgePrimed(): Promise<void> {
  return electronAuthBridgePrimed;
}

// Electron auth bridge priming (for mac-app)
// Bidirectional: Electron store -> localStorage, and localStorage -> Electron store
if (typeof window !== 'undefined' && window.api?.auth) {
  const bridgeCheckStartedAtLogoutEpoch = window.localStorage.getItem(LOGOUT_EPOCH_KEY);
  const bridgeCheckStartedDuringLogout = window.localStorage.getItem(LOGOUT_PENDING_KEY) === '1';

  electronAuthBridgePrimed = window.api.auth
    .check()
    .then((electronSession) => {
      if (window.localStorage.getItem(LOGOUT_EPOCH_KEY) !== bridgeCheckStartedAtLogoutEpoch) {
        console.log('[Supabase] Skipping stale Electron auth bridge result after logout');
        return;
      }

      if (electronSession) {
        if (bridgeCheckStartedDuringLogout || window.localStorage.getItem(LOGOUT_PENDING_KEY)) {
          console.log('[Supabase] Skipping Electron auth bridge prime after logout');
          return;
        }
        console.log('[Supabase] Primed session from Electron auth bridge');
        window.localStorage.setItem(SESSION_KEY, JSON.stringify(electronSession));
      } else {
        if (window.localStorage.getItem(LOGOUT_PENDING_KEY)) return;
        // Electron store empty but localStorage may have a session — sync it over
        // so main-process services (BrowserStateSync, etc.) can authenticate
        const localSession = getSession();
        if (localSession) {
          console.log('[Supabase] Syncing localStorage session to Electron auth bridge');
          window.api.auth.save(localSession).catch((err: unknown) => {
            console.warn('[Supabase] Failed to sync session to Electron auth bridge', err);
          });
        }
      }
    })
    .catch((error) => {
      console.warn('[Supabase] Failed to check Electron auth bridge', error);
    });
}
