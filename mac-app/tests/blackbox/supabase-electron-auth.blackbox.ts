/**
 * Blackbox coverage for the mac-app Electron auth bridge inside
 * front-end/src/lib/supabase.ts.
 *
 * Critical path for the logout-refresh regression:
 *   Terminal logout -> signOut() -> clearSession() -> window.api.auth.clear()
 *   -> renderer refresh -> module-level window.api.auth.check()
 *   -> localStorage session primed from Electron store.
 *
 * The expected contract is that signOut does not complete until the Electron
 * persisted auth store has been cleared. Otherwise a fast refresh can restore
 * the old session from Electron storage and the app appears logged in again.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    realtime: {
      setAuth: vi.fn(async () => undefined),
    },
  })),
}));

const SESSION_KEY = 'rose-session';
const USER_CACHE_KEY = 'app-user';
const LOGOUT_EPOCH_KEY = 'rose-session-logout-epoch';

function testSession(id = 'user-1') {
  return {
    access_token: `access-${id}`,
    refresh_token: `refresh-${id}`,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: {
      id,
      is_anonymous: false,
      aud: 'authenticated',
      role: 'authenticated',
      created_at: '2026-05-09T00:00:00.000Z',
      updated_at: '2026-05-09T00:00:00.000Z',
      app_metadata: {},
      user_metadata: {},
    },
  };
}

function anonymousSession(id = 'anon-1') {
  return {
    ...testSession(id),
    user: {
      ...testSession(id).user,
      is_anonymous: true,
      app_metadata: { provider: 'anonymous', providers: ['anonymous'] },
    },
  };
}

async function importSupabaseModule() {
  return import('@/lib/supabase');
}

describe('supabase Electron auth bridge blackbox', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    window.localStorage.clear();
    delete window.api;
  });

  it('does not restore the previous Electron session when the renderer refreshes after signOut', async () => {
    const storedSession = testSession();
    let electronSession: unknown = storedSession;
    let finishElectronClear: (() => void) | null = null;

    window.localStorage.setItem(SESSION_KEY, JSON.stringify(storedSession));
    window.localStorage.setItem(USER_CACHE_KEY, JSON.stringify(storedSession.user));

    window.api = {
      auth: {
        check: vi.fn(async () => electronSession),
        save: vi.fn(async (session: unknown) => {
          electronSession = session;
          return { success: true };
        }),
        clear: vi.fn(
          () =>
            new Promise<{ success: true }>((resolve) => {
              finishElectronClear = () => {
                electronSession = null;
                resolve({ success: true });
              };
            })
        ),
      },
    } as typeof window.api;

    const firstLoad = await importSupabaseModule();
    const signOutPromise = firstLoad.signOut();
    let signOutResolved = false;
    void signOutPromise.then(() => {
      signOutResolved = true;
    });

    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(finishElectronClear).not.toBeNull();
    await Promise.resolve();
    expect(signOutResolved).toBe(false);

    firstLoad.storeSession(anonymousSession());
    expect(window.api.auth.save).toHaveBeenCalledTimes(0);

    vi.resetModules();
    await importSupabaseModule();

    await waitFor(() => {
      expect(window.api.auth.check).toHaveBeenCalledTimes(2);
    });

    const sessionAfterRefresh = JSON.parse(window.localStorage.getItem(SESSION_KEY) ?? 'null') as {
      user?: { id?: string; is_anonymous?: boolean };
    } | null;
    expect(sessionAfterRefresh?.user?.is_anonymous).toBe(true);
    expect(sessionAfterRefresh?.user?.id).toBe('anon-1');

    finishElectronClear?.();
    await signOutPromise;
    expect(signOutResolved).toBe(true);
  });

  it('ignores an in-flight Electron auth check that resolves with the old session after signOut', async () => {
    const storedSession = testSession('stale-user');
    let resolveElectronCheck: ((session: unknown) => void) | null = null;
    let electronSession: unknown = storedSession;

    window.localStorage.setItem(SESSION_KEY, JSON.stringify(storedSession));
    window.localStorage.setItem(USER_CACHE_KEY, JSON.stringify(storedSession.user));

    window.api = {
      auth: {
        check: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveElectronCheck = resolve;
            })
        ),
        save: vi.fn(async (session: unknown) => {
          electronSession = session;
          return { success: true };
        }),
        clear: vi.fn(async () => {
          electronSession = null;
          return { success: true };
        }),
      },
    } as typeof window.api;

    const firstLoad = await importSupabaseModule();
    await firstLoad.signOut();
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
    expect(window.localStorage.getItem(LOGOUT_EPOCH_KEY)).not.toBeNull();

    resolveElectronCheck?.(storedSession);

    await waitFor(() => {
      expect(window.api.auth.check).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();

    expect(electronSession).toBeNull();
    expect(window.localStorage.getItem(SESSION_KEY)).toBeNull();
  });
});
