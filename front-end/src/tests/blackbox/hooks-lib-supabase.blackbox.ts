import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from './msw/server';

import {
  clearSession,
  clearStoredSession,
  createAnonymousSession,
  getCachedUser,
  getSession,
  getStoredSession,
  hasSession,
  initializeRealtime,
  isAnonymousUser,
  isRealtimeReady,
  persistCachedUser,
  setRealtimeAuth,
  signOut,
  storeSession,
} from '@/lib/supabase';

const API_BASE = 'http://localhost:3001/api';

function mockSession() {
  const session = {
    access_token:
      'eyJhbGciOiJIUzI1NiJ9.' +
      btoa(JSON.stringify({ sub: 'user-12345678', role: 'authenticated' })) +
      '.signature-signature-signature',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'user-12345678', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  return session;
}

describe('lib/supabase', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('getSession returns null when no session stored', () => {
    expect(getSession()).toBeNull();
    expect(hasSession()).toBe(false);
  });

  it('getSession returns null and clears when session expired', () => {
    const expired = {
      access_token: 't',
      refresh_token: 'r',
      expires_in: 0,
      expires_at: Math.floor(Date.now() / 1000) - 10,
      token_type: 'bearer',
      user: { id: 'u' },
    };
    localStorage.setItem('rose-session', JSON.stringify(expired));
    expect(getSession()).toBeNull();
    expect(localStorage.getItem('rose-session')).toBeNull();
  });

  // RCA cement. Impersonated sessions are deliberately short-lived (1h), and the
  // expiry branch above called clearSession() -> clearImpersonationState(), which
  // deleted the STASHED ADMIN SESSION. That stash is the only way back from an
  // account switch, so a routine expiry silently stranded the admin: the switcher
  // pill disappeared and every admin-gated call lost its authority at the same
  // moment, with no recovery path. An expiring impersonation must unwind, not
  // detonate.
  it('getSession restores the admin session when an impersonated session expires', () => {
    const adminSession = {
      access_token: 'admin-token',
      refresh_token: 'admin-refresh',
      expires_in: 7776000,
      expires_at: Math.floor(Date.now() / 1000) + 7776000,
      token_type: 'bearer',
      user: { id: 'admin-1' },
    };
    const expiredImpersonated = {
      access_token: 'target-token',
      refresh_token: 'target-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) - 10,
      token_type: 'bearer',
      user: { id: 'target-1' },
    };
    localStorage.setItem('rose-session', JSON.stringify(expiredImpersonated));
    localStorage.setItem('rose-admin-session', JSON.stringify(adminSession));
    localStorage.setItem(
      'rose-impersonation',
      JSON.stringify({
        userId: 'target-1',
        name: 'Grace',
        email: null,
        phone: null,
        isAdmin: false,
      }),
    );

    // The admin is handed back their own session rather than being logged out.
    expect(getSession()?.user?.id).toBe('admin-1');
    expect(getSession()?.access_token).toBe('admin-token');
    // Impersonation bookkeeping is unwound, not left dangling.
    expect(localStorage.getItem('rose-impersonation')).toBeNull();
    expect(localStorage.getItem('rose-admin-session')).toBeNull();
  });

  it('getSession still clears when BOTH the impersonated and stashed sessions expired', () => {
    const stale = (id: string) => ({
      access_token: `${id}-token`,
      refresh_token: 'r',
      expires_in: 0,
      expires_at: Math.floor(Date.now() / 1000) - 10,
      token_type: 'bearer',
      user: { id },
    });
    localStorage.setItem('rose-session', JSON.stringify(stale('target-1')));
    localStorage.setItem('rose-admin-session', JSON.stringify(stale('admin-1')));
    localStorage.setItem(
      'rose-impersonation',
      JSON.stringify({ userId: 'target-1', name: null, email: null, phone: null, isAdmin: false }),
    );

    expect(getSession()).toBeNull();
    expect(localStorage.getItem('rose-impersonation')).toBeNull();
    expect(localStorage.getItem('rose-admin-session')).toBeNull();
  });

  it('getSession returns null on parse error', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('rose-session', 'not-json');
    expect(getSession()).toBeNull();
    warnSpy.mockRestore();
  });

  it('storeSession + getSession round-trip', () => {
    const session = {
      access_token: 't',
      refresh_token: 'r',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: 'u-1' } as never,
    } as never;
    storeSession(session);
    expect(getSession()?.user?.id).toBe('u-1');
    expect(hasSession()).toBe(true);
    expect(getStoredSession()?.user?.id).toBe('u-1');
  });

  it('clearSession wipes storage (including legacy alias)', () => {
    localStorage.setItem('rose-session', '{"access_token":"x"}');
    localStorage.setItem('app-user', '{"id":"u"}');
    clearSession();
    expect(localStorage.getItem('rose-session')).toBeNull();
    expect(localStorage.getItem('app-user')).toBeNull();
    // legacy alias
    clearStoredSession();
  });

  it('getCachedUser returns parsed user or null; persistCachedUser stores and clears', () => {
    expect(getCachedUser()).toBeNull();
    persistCachedUser({ id: 'u1' } as never);
    expect(getCachedUser()?.id).toBe('u1');
    persistCachedUser(null);
    expect(getCachedUser()).toBeNull();
  });

  it('getCachedUser returns null on parse error', () => {
    localStorage.setItem('app-user', 'not-json');
    expect(getCachedUser()).toBeNull();
  });

  it('isAnonymousUser', () => {
    expect(isAnonymousUser(null)).toBe(false);
    expect(isAnonymousUser({ is_anonymous: true } as never)).toBe(true);
    expect(isAnonymousUser({ is_anonymous: false } as never)).toBe(false);
  });

  it('createAnonymousSession: parses response and stores session', async () => {
    server.use(
      http.post(`${API_BASE}/auth/anonymous`, () =>
        HttpResponse.json({
          user: { id: 'anon-1' },
          session: {
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
          },
        }),
      ),
    );
    const { user, session } = await createAnonymousSession();
    expect(user.id).toBe('anon-1');
    expect(session.access_token).toBe('at');
    expect(localStorage.getItem('rose-session')).toContain('anon-1');
  });

  it('createAnonymousSession: throws on non-ok response', async () => {
    server.use(
      http.post(`${API_BASE}/auth/anonymous`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    await expect(createAnonymousSession()).rejects.toThrow('boom');
  });

  it('signOut clears the session', async () => {
    mockSession();
    await signOut();
    expect(hasSession()).toBe(false);
  });

  it('setRealtimeAuth toggles isRealtimeReady', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await setRealtimeAuth(null);
    expect(isRealtimeReady()).toBe(false);
    // Exercise identifyToken's invalid + anon_key paths via setRealtimeAuth.
    await setRealtimeAuth('short');
    expect(isRealtimeReady()).toBe(true);
    await setRealtimeAuth(null);
    expect(isRealtimeReady()).toBe(false);
    logSpy.mockRestore();
  });

  it('setRealtimeAuth recognises anon JWT', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const anonToken = 'eyJhbGciOiJIUzI1NiJ9.' + btoa(JSON.stringify({ role: 'anon' })) + '.sig';
    await setRealtimeAuth(anonToken);
    expect(isRealtimeReady()).toBe(true);
    await setRealtimeAuth(null);
    logSpy.mockRestore();
  });

  it('initializeRealtime calls setRealtimeAuth when session exists', async () => {
    mockSession();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await initializeRealtime();
    expect(isRealtimeReady()).toBe(true);
    await setRealtimeAuth(null);
    logSpy.mockRestore();
  });

  it('initializeRealtime no-ops without a session', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await setRealtimeAuth(null);
    await initializeRealtime();
    expect(isRealtimeReady()).toBe(false);
    logSpy.mockRestore();
  });
});
