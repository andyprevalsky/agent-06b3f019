/**
 * Blackbox: the app query cache is scoped to the signed-in user (lib/queryClient).
 *
 * Contract (follow-up to PR #1975; project names and repos are account data):
 *   - account A's projects (Integrations › Projects, useIntegrationProjects) are
 *     cached in the shared appQueryClient
 *   - A signs out (to the anonymous session) and account B signs in on the same tab
 *   - from the switch on, the projects list never returns A's data, even while
 *     B's response is still in flight
 *   - a token refresh for the same user keeps the cache (no refetch)
 *   - a root-browser action account A started that completes after B signs in
 *     never writes A's state into B's cache (CodeRabbit review of #2052)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';

import { useAuthActions } from '@/features/auth/hooks/useAuthActions';
import { useIntegrationProjects } from '@/features/integrations/hooks/useIntegrationProjects';
import {
  ROOT_BROWSER_KEY,
  useRootBrowserActions,
} from '@/features/terminal-component-group/components/rose-apps/useBrowserWorld';
import { appQueryClient, resetQueryCacheScope } from '@/lib/queryClient';

import { makeProject } from './rose-sidebar.fixtures';
import { server } from './msw/server';

const { sessionOf } = vi.hoisted(() => ({
  sessionOf: (id: string, anonymous = false) =>
    ({
      access_token: `token-${id}`,
      refresh_token: `refresh-${id}`,
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id, is_anonymous: anonymous },
    }) as unknown as Session,
}));

vi.mock('@/lib/supabase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase')>()),
  setRealtimeAuth: vi.fn(async () => undefined),
  createAnonymousSession: vi.fn(async () => ({ session: sessionOf('anon-user', true) })),
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  checkNeedsInviteCode: vi.fn(async () => false),
}));

const API_BASE = 'http://localhost:3001/api';

/** useAuthActions with real React state, as in useAuth: identity changes re-render the hooks. */
function useStatefulAuthActions() {
  const [, setUser] = useState<User | null>(null);
  const [, setSession] = useState<Session | null>(null);
  const [, setIsFullySignedIn] = useState(false);
  const [, setInviteRequired] = useState(false);
  const [, setRealtimeReady] = useState(false);
  return useAuthActions({
    setUser,
    setSession,
    setIsFullySignedIn,
    setInviteRequired,
    setRealtimeReady,
  });
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={appQueryClient}>{children}</QueryClientProvider>
);

describe('query cache user scope', () => {
  beforeEach(() => {
    appQueryClient.clear();
    resetQueryCacheScope();
  });
  afterEach(() => {
    appQueryClient.clear();
    resetQueryCacheScope();
    localStorage.clear();
  });

  it("never returns the previous account's projects after sign-out and another sign-in", async () => {
    const owner = { current: 'user-a' };
    const fetches = { projects: 0 };
    let releaseB: () => void = () => {};
    const bReady = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    server.use(
      http.get(`${API_BASE}/projects`, async () => {
        fetches.projects += 1;
        const user = owner.current;
        if (user !== 'user-a') await bReady; // B's response is still in flight
        return HttpResponse.json({
          projects: [
            makeProject({
              id: `${user}-project`,
              name: `${user} project`,
              repoUrl: `https://github.com/${user}/secret`,
            }),
          ],
        });
      }),
    );
    localStorage.setItem('rose-session', JSON.stringify(sessionOf('user-a')));

    const observed: string[] = [];
    const { result } = renderHook(
      () => {
        const auth = useStatefulAuthActions();
        const projects = useIntegrationProjects(true);
        observed.push(...projects.projects.map((p) => `${p.name} ${p.repoUrl ?? ''}`));
        return { auth, projects };
      },
      { wrapper },
    );

    await act(() => result.current.auth.applySession('init', sessionOf('user-a')));
    await waitFor(() =>
      expect(result.current.projects.projects.map((p) => p.name)).toEqual(['user-a project']),
    );

    // A signs out; B signs in on the same tab while B's lists are still loading.
    observed.length = 0;
    owner.current = 'user-b';
    await act(async () => {
      await result.current.auth.signOut();
      localStorage.setItem('rose-session', JSON.stringify(sessionOf('user-b')));
      await result.current.auth.applySession('login', sessionOf('user-b'));
    });
    expect(observed.filter((name) => name.includes('user-a'))).toEqual([]);
    expect(result.current.projects.projects).toEqual([]);
    expect(result.current.projects.loading).toBe(true);

    releaseB();
    await waitFor(() =>
      expect(result.current.projects.projects.map((p) => p.name)).toEqual(['user-b project']),
    );
    expect(observed.filter((name) => name.includes('user-a'))).toEqual([]);

    // A token refresh for the same account keeps the cache: no refetch.
    const before = { ...fetches };
    await act(() => result.current.auth.applySession('refresh', sessionOf('user-b')));
    expect(result.current.projects.projects.map((p) => p.name)).toEqual(['user-b project']);
    expect(fetches).toEqual(before);
  });

  it('drops a root-browser open that account A started if it completes after B signs in', async () => {
    let releaseOpen: () => void = () => {};
    const openReady = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    server.use(
      http.post(`${API_BASE}/browser-world/root/open`, async () => {
        await openReady; // A's open is still in flight when B signs in
        return HttpResponse.json({
          root: { session_id: 'a-root-session', live_url: 'https://live.example/a' },
        });
      }),
    );
    localStorage.setItem('rose-session', JSON.stringify(sessionOf('user-a')));
    const { result } = renderHook(
      () => ({ auth: useStatefulAuthActions(), root: useRootBrowserActions() }),
      { wrapper },
    );
    await act(() => result.current.auth.applySession('init', sessionOf('user-a')));

    let opened: Promise<unknown> = Promise.resolve();
    act(() => {
      opened = result.current.root.open.mutateAsync('https://a.example').catch(() => undefined);
    });
    await waitFor(() => expect(result.current.root.open.isPending).toBe(true));

    await act(async () => {
      await result.current.auth.signOut();
      localStorage.setItem('rose-session', JSON.stringify(sessionOf('user-b')));
      await result.current.auth.applySession('login', sessionOf('user-b'));
    });
    // B's own read of Root: nothing open.
    const bRoot = { root: null, sites: [], default_url: null };
    appQueryClient.setQueryData([...ROOT_BROWSER_KEY, null], bRoot);

    releaseOpen();
    await act(async () => {
      await opened;
    });
    expect(appQueryClient.getQueryData([...ROOT_BROWSER_KEY, null])).toEqual(bRoot);
  });
});
