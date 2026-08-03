/**
 * Blackbox tests for the auth domain.
 *
 * Domain entry: main/services/auth.ts (AuthService).
 *
 * AuthService is a static-class facade over an `electron-store`-backed session
 * blob. The three public entrypoints are:
 *   - getSession()   — read the persisted session, auto-normalize expires_at,
 *                      and transparently refresh against Supabase when the
 *                      token is expired or within 60s of expiring.
 *   - setSession(s)  — persist a session, normalizing expires_at (seconds -> ms).
 *   - clearSession() — delete the persisted session.
 *
 * The one third-party boundary is
 *   POST {supabase.url}/auth/v1/token?grant_type=refresh_token
 * invoked from the private refreshToken() path inside getSession().
 *
 * Test strategy:
 *   - Mock `electron-store` with a schema-faithful in-memory store so importing
 *     AuthService is safe in the jsdom-on-Node test environment and an unset
 *     `session` key reads back as null (matching
 *     `Store<{session: AuthSession | null}>`).
 *   - Mock the shared `../../main/base/config` so the encryption key + Supabase
 *     URL/anonKey are deterministic (the real config.ts throws at import time
 *     if VITE_SUPABASE_* env vars are missing).
 *   - Exercise getSession/setSession/clearSession against a captured fetch so
 *     the Supabase refresh boundary is asserted on URL, method, headers, and
 *     request body.
 *   - Compute "expired" / "expiring soon" / "valid" expires_at values relative
 *     to Date.now() at call time. We don't stub the clock — the 60s pre-expiry
 *     buffer and refresh logic are stable against wall-clock.
 *
 * Scope deferrals per batch rules: flake x5, concurrent-invocation,
 * negative-control, and broader-suite runs are owned by the parent skill.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchCapture, fetchCaptures, clearFetchCaptures } from './fetch-capture';

// ---------------------------------------------------------------------------
// auth.ts only reaches into `electron-store` and the shared `../base/config`
// module. We intentionally do NOT import from `./electron-stubs` because that
// file's `stubElectronStore()` registers a global `vi.mock('electron-store')`
// whose get() returns `undefined` for unset keys — that crashes
// `normalizeSession(session.expires_at)` inside getSession() when the store
// has never been written to.
//
// Instead we mock `electron-store` directly with a schema-faithful in-memory
// store whose get() returns `null` for unset keys, matching the declared
// `Store<{session: AuthSession | null}>` generic. The store below is sufficient
// for auth.ts — it only uses get/set/delete on the single 'session' key.
// ---------------------------------------------------------------------------

interface RawStore {
  __raw: Map<string, unknown>;
  get: (key: string, fallback?: unknown) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
  clear: () => void;
  has: (key: string) => boolean;
}

// vi.mock factories are hoisted above all module-level statements, so any value
// they close over must be declared via vi.hoisted() — regular `const` would be
// in a temporal-dead-zone at factory-invocation time.
const rawStores = vi.hoisted(() => [] as RawStore[]);

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => {
    const storage = new Map<string, unknown>();
    const store: RawStore = {
      __raw: storage,
      get: (key: string, fallback?: unknown) => {
        if (storage.has(key)) return storage.get(key);
        return fallback;
      },
      set: (key: string, value: unknown) => {
        storage.set(key, value);
      },
      delete: (key: string) => {
        storage.delete(key);
      },
      clear: () => storage.clear(),
      has: (key: string) => storage.has(key),
    };
    rawStores.push(store);
    return store;
  }),
}));

function writeRawSession(session: unknown): void {
  const store = rawStores[0];
  if (!store) throw new Error('electron-store mock not initialized');
  store.__raw.set('session', session);
}

// ---------------------------------------------------------------------------
// Mock the shared config before any domain import. auth.ts reads
// `config.encryptionKey` at module eval (inside `new Store(...)`) and
// `config.supabase.{url,anonKey}` inside refreshToken(), so both must be set
// before AuthService is imported.
//
// vi.mock is hoisted above every statement in the file, so its factory cannot
// reference local consts. These constants duplicate the literals inside the
// factory and are only used by the test bodies for assertions.
// ---------------------------------------------------------------------------

const TEST_SUPABASE_URL = 'https://supabase.test';
const TEST_SUPABASE_ANON = 'anon-test-key';

vi.mock('../../main/base/config', () => ({
  config: {
    apiUrl: 'http://localhost:3001',
    supabase: { url: 'https://supabase.test', anonKey: 'anon-test-key' },
    encryptionKey: 'test-encryption-key',
    isDev: true,
  },
}));

// ---------------------------------------------------------------------------
// Imports — after all mocks. AuthService is the public surface of the domain.
// ---------------------------------------------------------------------------

import { AuthService } from '../../main/services/auth';
import type { AuthSession } from '../../shared/types/ipc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REFRESH_URL = `${TEST_SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`;

/**
 * Build a JSON Response suitable for the fetch-capture responder map.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Captures of the single outbound boundary in this domain — the Supabase
 * refresh-token endpoint. Other captured URLs would be a test bug.
 */
function refreshCalls() {
  return fetchCaptures.filter((c) => c.url.includes('/auth/v1/token'));
}

/**
 * Session that's valid for the next hour. Expires_at is already in ms so
 * normalizeSession leaves it alone.
 */
function freshSession(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    access_token: 'access-valid',
    refresh_token: 'refresh-valid',
    expires_at: Date.now() + 60 * 60 * 1000,
    user: { id: 'u-1' },
    ...overrides,
  };
}

/**
 * Shape of the Supabase token response the refresh path expects.
 */
function refreshResponderOk(
  overrides: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    user?: unknown;
  } = {}
) {
  return () =>
    jsonResponse({
      access_token: overrides.access_token ?? 'access-refreshed',
      refresh_token: overrides.refresh_token ?? 'refresh-refreshed',
      expires_in: overrides.expires_in ?? 3600,
      user: overrides.user ?? { id: 'u-1' },
    });
}

/**
 * AuthService is a static singleton whose `electron-store` instance is created
 * at module load and reused across all tests in the worker. clearSession()
 * resets the store back to the empty state each test assumes.
 */
function resetAuthState(): void {
  AuthService.clearSession();
  clearFetchCaptures();
  vi.clearAllMocks();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth blackbox', () => {
  let restoreFetch: () => void = () => {};

  beforeEach(() => {
    resetAuthState();
  });

  afterEach(() => {
    restoreFetch();
    restoreFetch = () => {};
  });

  // -------------------------------------------------------------------------
  // Empty state — no session stored.
  // -------------------------------------------------------------------------

  describe('empty state', () => {
    it('getSession returns null when no session has been stored', async () => {
      restoreFetch = installFetchCapture({});

      const result = await AuthService.getSession();

      expect(result).toBeNull();
      // No refresh attempt should fire when there's nothing to refresh.
      expect(refreshCalls()).toHaveLength(0);
    });

    it('clearSession on an already-empty store is a safe no-op', async () => {
      restoreFetch = installFetchCapture({});

      expect(() => AuthService.clearSession()).not.toThrow();
      expect(await AuthService.getSession()).toBeNull();
      expect(refreshCalls()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Happy path — valid session, no refresh needed.
  // -------------------------------------------------------------------------

  describe('happy path — valid session', () => {
    it('setSession + getSession round-trips without touching the network', async () => {
      restoreFetch = installFetchCapture({});
      const session = freshSession();

      AuthService.setSession(session);
      const result = await AuthService.getSession();

      expect(result).toEqual(session);
      expect(refreshCalls()).toHaveLength(0);
    });

    it('getSession does not refresh when expires_at is comfortably in the future', async () => {
      restoreFetch = installFetchCapture({
        '/auth/v1/token': refreshResponderOk(),
      });
      AuthService.setSession(freshSession({ expires_at: Date.now() + 10 * 60 * 1000 }));

      const result = await AuthService.getSession();

      expect(result).not.toBeNull();
      expect(result!.access_token).toBe('access-valid');
      expect(refreshCalls()).toHaveLength(0);
    });

    it('setSession normalizes a seconds-precision expires_at to milliseconds', async () => {
      restoreFetch = installFetchCapture({});
      // expires_at in seconds, one hour from now. toMillis multiplies by 1000
      // when the value is below the 1e12 threshold.
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresSec = nowSec + 3600;

      AuthService.setSession({
        access_token: 'a',
        refresh_token: 'r',
        user: null,
        expires_at: expiresSec,
      });

      const result = await AuthService.getSession();
      expect(result).not.toBeNull();
      // Stored/returned value must be ms, not seconds.
      expect(result!.expires_at).toBe(expiresSec * 1000);
      // And must be a real future timestamp in ms.
      expect(result!.expires_at).toBeGreaterThan(Date.now());
      expect(refreshCalls()).toHaveLength(0);
    });

    it('getSession self-heals a legacy seconds-precision stored expires_at on first read', async () => {
      restoreFetch = installFetchCapture({});
      // Pretend a previous app version stored expires_at in seconds and we're
      // reading it back. normalizeSession inside getSession should rewrite it
      // to ms, persist the normalized version, and return the normalized value.
      //
      // Bypass setSession (which itself normalizes) and seed the raw store
      // directly so the legacy-seconds value actually hits disk.
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresSec = nowSec + 3600;
      writeRawSession({
        access_token: 'a',
        refresh_token: 'r',
        user: null,
        expires_at: expiresSec,
      });

      const first = await AuthService.getSession();
      const second = await AuthService.getSession();

      expect(first!.expires_at).toBe(expiresSec * 1000);
      // Second read sees the already-normalized value, still valid, no refresh.
      expect(second!.expires_at).toBe(expiresSec * 1000);
      expect(refreshCalls()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // clearSession — state transition to empty.
  // -------------------------------------------------------------------------

  describe('clearSession', () => {
    it('clearSession wipes a stored session so the next getSession returns null', async () => {
      restoreFetch = installFetchCapture({});
      AuthService.setSession(freshSession());
      expect(await AuthService.getSession()).not.toBeNull();

      AuthService.clearSession();

      expect(await AuthService.getSession()).toBeNull();
      expect(refreshCalls()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Auth boundary — refresh flow when the stored token is expired or within
  // the 60-second expiry buffer.
  // -------------------------------------------------------------------------

  describe('auth boundary — refresh on expiry', () => {
    it('never refreshes an impersonated session and preserves its actor claim', async () => {
      restoreFetch = installFetchCapture({
        '/auth/v1/token': refreshResponderOk({
          access_token: 'would-strip-actor',
        }),
      });
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const impersonatedAccessToken = `${encode({ alg: 'HS256' })}.${encode({
        sub: 'target-user',
        act: { sub: 'admin-user' },
      })}.signature`;
      AuthService.setSession(
        freshSession({
          access_token: impersonatedAccessToken,
          expires_at: Date.now() + 30_000,
        })
      );

      const result = await AuthService.getSession();

      expect(result?.access_token).toBe(impersonatedAccessToken);
      expect(refreshCalls()).toHaveLength(0);
    });

    it('refreshes and returns a new session when the stored token is already expired', async () => {
      restoreFetch = installFetchCapture({
        '/auth/v1/token': refreshResponderOk({
          access_token: 'access-refreshed',
          refresh_token: 'refresh-refreshed',
          expires_in: 3600,
        }),
      });
      // Expired 10 seconds ago.
      AuthService.setSession(freshSession({ expires_at: Date.now() - 10_000 }));

      const before = Date.now();
      const result = await AuthService.getSession();
      const after = Date.now();

      expect(result).not.toBeNull();
      expect(result!.access_token).toBe('access-refreshed');
      expect(result!.refresh_token).toBe('refresh-refreshed');
      // expires_at is now computed as Date.now() + expires_in * 1000.
      expect(result!.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(result!.expires_at).toBeLessThanOrEqual(after + 3600 * 1000);
      expect(refreshCalls()).toHaveLength(1);

      // The refreshed session is persisted — a follow-up read returns the new
      // token without a second network hit.
      clearFetchCaptures();
      const followUp = await AuthService.getSession();
      expect(followUp!.access_token).toBe('access-refreshed');
      expect(refreshCalls()).toHaveLength(0);
    });

    it('refreshes when the stored token is within the 60s pre-expiry buffer', async () => {
      restoreFetch = installFetchCapture({
        '/auth/v1/token': refreshResponderOk(),
      });
      // Expires in 30s — inside the 60s buffer, so refresh is triggered.
      AuthService.setSession(freshSession({ expires_at: Date.now() + 30_000 }));

      const result = await AuthService.getSession();

      expect(result!.access_token).toBe('access-refreshed');
      expect(refreshCalls()).toHaveLength(1);
    });

    it('clears the session when a refresh for an already-expired token fails', async () => {
      restoreFetch = installFetchCapture({
        '/auth/v1/token': () => jsonResponse({ error: 'invalid_grant' }, 401),
      });
      AuthService.setSession(freshSession({ expires_at: Date.now() - 10_000 }));

      const result = await AuthService.getSession();

      expect(result).toBeNull();
      expect(refreshCalls()).toHaveLength(1);
      // Session should have been wiped.
      clearFetchCaptures();
      const followUp = await AuthService.getSession();
      expect(followUp).toBeNull();
      expect(refreshCalls()).toHaveLength(0);
    });

    it('keeps the still-valid session when refresh fails but the token has not yet expired', async () => {
      restoreFetch = installFetchCapture({
        '/auth/v1/token': () => jsonResponse({ error: 'temporary' }, 500),
      });
      // Inside the 60s buffer but not yet expired.
      const expiresAt = Date.now() + 30_000;
      AuthService.setSession(freshSession({ expires_at: expiresAt }));

      const result = await AuthService.getSession();

      // Refresh was attempted and failed, but since the token is technically
      // still valid (not yet past expires_at), the original session is returned
      // rather than cleared.
      expect(result).not.toBeNull();
      expect(result!.access_token).toBe('access-valid');
      expect(refreshCalls()).toHaveLength(1);
    });

    it('returns null on an expired session when a transient 5xx refresh fails and the token is past expiry', async () => {
      restoreFetch = installFetchCapture({
        '/auth/v1/token': () => jsonResponse({ error: 'upstream' }, 503),
      });
      AuthService.setSession(freshSession({ expires_at: Date.now() - 1 }));

      const result = await AuthService.getSession();

      expect(result).toBeNull();
      expect(refreshCalls()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Boundary capture — exact params sent to Supabase /auth/v1/token.
  // -------------------------------------------------------------------------

  describe('boundary capture (/auth/v1/token)', () => {
    it('sends POST to {supabase.url}/auth/v1/token?grant_type=refresh_token with correct headers and body', async () => {
      restoreFetch = installFetchCapture({
        '/auth/v1/token': refreshResponderOk(),
      });
      AuthService.setSession(
        freshSession({
          refresh_token: 'refresh-under-test',
          expires_at: Date.now() - 1, // force refresh
        })
      );

      await AuthService.getSession();

      const calls = refreshCalls();
      expect(calls).toHaveLength(1);
      const call = calls[0];

      // Exact URL including the grant_type query param.
      expect(call.url).toBe(REFRESH_URL);
      expect(call.method).toBe('POST');

      // Both the Supabase anon apikey and content-type must be forwarded.
      expect(call.headers['content-type']).toBe('application/json');
      expect(call.headers.apikey).toBe(TEST_SUPABASE_ANON);

      // Body is JSON with exactly the stored refresh_token.
      expect(call.body).not.toBeNull();
      const parsed = JSON.parse(call.body as string) as { refresh_token: string };
      expect(parsed).toEqual({ refresh_token: 'refresh-under-test' });
    });

    it('makes zero outbound refresh calls when there is no session to refresh', async () => {
      // Register a responder so the capture layer is watching /auth/v1/token —
      // if getSession were to hit it (regression), the call would be recorded.
      restoreFetch = installFetchCapture({
        '/auth/v1/token': refreshResponderOk(),
      });

      await AuthService.getSession();

      expect(refreshCalls()).toHaveLength(0);
    });
  });
});
