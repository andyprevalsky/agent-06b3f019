/** Invitation proof survives the actual LoginButton destination and session event. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import type { Session } from '@supabase/supabase-js';
import { TooltipProvider } from '@/components/ui/tooltip';
import { LoginButton, WaitlistGate, useAuth } from '@/features/auth';
import { RoseAppsProvider } from '@/features/terminal-component-group';
import TeamInviteContinuation from '@/components/teams/TeamInviteContinuation';
import { isRoseDesktopSession } from '@/lib/roseDesktopSession';
import {
  captureTeamInviteAtEntry,
  captureTeamInviteLink,
  clearTeamInviteLink,
} from '@/lib/teamInviteLink';
import { AUTH_SESSION_CHANGED_EVENT, storeSession } from '@/lib/supabase';
import { mockTeams, makeTeam, TEAM_API } from './teams.fixtures';
import { server } from './msw/server';
import { capturedRequests } from './msw/capture';

function session(anonymous: boolean): Session {
  return {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: anonymous ? 'anonymous-phone-user' : 'phone-invitee',
      is_anonymous: anonymous,
      email: undefined,
      aud: 'authenticated',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-11-11T00:00:00Z',
    },
  };
}

// eslint-disable-next-line react-refresh/only-export-components -- local routing fixture
function ApplicationRoute() {
  const auth = useAuth({ passive: true });
  return (
    <RoseAppsProvider
      publishLayout={isRoseDesktopSession({
        isAnonymous: auth.isAnonymous,
        authUser: auth.user,
        inviteRequired: auth.inviteRequired,
      })}
      invitationReady={auth.isFullySignedIn}
    >
      <p>Application route</p>
      <LoginButton />
    </RoseAppsProvider>
  );
}
// eslint-disable-next-line react-refresh/only-export-components -- local routing fixture
function RouteHarness() {
  return (
    <>
      <TeamInviteContinuation />
      <WaitlistGate />
      <Routes>
        <Route
          path="/download"
          element={
            <>
              <p>Public landing</p>
              <LoginButton />
            </>
          }
        />
        <Route
          path="/terminal"
          element={
            <>
              <p>Legacy landing</p>
              <LoginButton />
            </>
          }
        />
        <Route path="/" element={<ApplicationRoute />} />
      </Routes>
    </>
  );
}
function renderRoutes() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <TooltipProvider>
        <BrowserRouter>
          <RouteHarness />
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}
function pendingInvitation() {
  const api = mockTeams(
    [],
    [makeTeam({ id: 'phone-invite', name: 'Invite-only team', status: 'INVITED', role: 'MEMBER' })],
  );
  // Phone-only account has no email match. Preview must use the captured proof.
  server.use(
    http.get(TEAM_API, () => HttpResponse.json({ teams: api.state.teams, invitations: [] })),
  );
  return api;
}

beforeEach(() => {
  localStorage.clear();
  clearTeamInviteLink();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  clearTeamInviteLink();
  window.history.replaceState(null, '', '/');
});

describe('invitation entry and sign-in navigation', () => {
  it('captures while signed out before LoginButton navigation, then previews and explicitly accepts after phone sign-in', async () => {
    const api = pendingInvitation();
    window.history.replaceState(
      { key: 'landing', idx: 0 },
      '',
      '/download?team-invite=phone-invite&keep=yes#team-invite-token=email-proof&section=signup',
    );
    expect(localStorage.getItem('rose-session')).toBeNull();
    captureTeamInviteAtEntry();
    expect(window.location.search).toBe('?keep=yes');
    expect(window.location.hash).toBe('#section=signup');
    expect(window.history.state).toEqual({ key: 'landing', idx: 0 });
    expect(window.location.href).not.toContain('email-proof');
    // The existing anonymous bootstrap and later verify-OTP flow both use storeSession.
    storeSession(session(true));
    const user = userEvent.setup();
    renderRoutes();
    await user.click(await screen.findByRole('button', { name: 'Login' }));
    expect(await screen.findByText('Legacy landing')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/terminal');
    expect(captureTeamInviteLink().token).toBe('email-proof');
    act(() => storeSession(session(false)));
    const accept = await screen.findByRole('button', { name: 'Accept invitation' });
    expect(window.location.pathname).toBe('/');
    expect(screen.getByText('Application route')).toBeInTheDocument();
    expect(api.writes).toHaveLength(0); // Authentication must never auto-accept.
    expect(
      capturedRequests.find((request) => request.url.endsWith('/phone-invite/invitation'))?.body,
    ).toEqual({ token: 'email-proof' });
    expect(capturedRequests.every((request) => !request.url.includes('email-proof'))).toBe(true);
    expect(JSON.stringify(window.history.state)).not.toContain('email-proof');
    await user.click(accept);
    expect(await screen.findByRole('heading', { name: 'Invite-only team' })).toBeInTheDocument();
    expect(api.writes[0].body).toEqual({ token: 'email-proof' });
    expect(captureTeamInviteLink().token).toBeNull();
    expect(api.state.teams[0].integrationShares).toEqual([]);
  });

  it('opens Teams when the application provider mounted before the phone session existed', async () => {
    const api = pendingInvitation();
    window.history.replaceState(
      {},
      '',
      '/?team-invite=phone-invite#team-invite-token=same-route-proof',
    );
    captureTeamInviteAtEntry();
    storeSession(session(true));
    renderRoutes();
    expect(await screen.findByText('Application route')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    act(() => storeSession(session(false)));
    expect(await screen.findByRole('button', { name: 'Accept invitation' })).toBeInTheDocument();
    expect(api.writes).toHaveLength(0);
  });

  it('keeps ordinary LoginButton navigation unchanged without an invitation', async () => {
    window.history.replaceState({}, '', '/download');
    captureTeamInviteAtEntry();
    storeSession(session(false));
    const user = userEvent.setup();
    renderRoutes();
    await user.click(await screen.findByRole('button', { name: 'Login' }));
    await waitFor(() => expect(window.location.pathname).toBe('/terminal'));
    expect(screen.getByText('Legacy landing')).toBeInTheDocument();
    expect(screen.queryByText('Application route')).toBeNull();
  });

  it('entry wiring captures and scrubs before auth rendering, startup logging and analytics', () => {
    const entry = readFileSync(join(process.cwd(), 'src/main.tsx'), 'utf8');
    const shell = readFileSync(
      join(process.cwd(), 'src/features/app-wiring/components/AppShell.tsx'),
      'utf8',
    );
    expect(shell).toContain('<TeamInviteContinuation />');
    const terminal = readFileSync(
      join(process.cwd(), 'src/features/terminal/components/TerminalContent.tsx'),
      'utf8',
    );
    expect(terminal).toContain('invitationReady={props.agents.isFullySignedIn}');
    const capture = entry.indexOf('captureTeamInviteAtEntry();');
    expect(capture).toBeGreaterThan(-1);
    for (const call of [
      'startPreviewHandoff();',
      'initDevLogging();',
      'initAmplitude();',
      'renderApp();',
    ]) {
      expect(capture).toBeLessThan(entry.indexOf(call));
    }
  });
  it('retains the invitation without opening it while the existing signup-code gate is required', async () => {
    const api = pendingInvitation();
    server.use(
      http.get('http://localhost:3001/api/invite-codes/check', () =>
        HttpResponse.json({ needsInviteCode: true }),
      ),
    );
    window.history.replaceState(
      {},
      '',
      '/?team-invite=phone-invite#team-invite-token=waitlisted-proof',
    );
    captureTeamInviteAtEntry();
    storeSession(session(false));
    renderRoutes();
    expect(await screen.findByText("You're On The Waitlist!")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).toBeNull();
    expect(
      capturedRequests.some((request) => request.url.endsWith('/phone-invite/invitation')),
    ).toBe(false);
    expect(captureTeamInviteLink().token).toBe('waitlisted-proof');
    expect(api.writes).toHaveLength(0);
    // The existing gate is admitted externally (e.g. a redeemed signup code).
    server.use(
      http.get('http://localhost:3001/api/invite-codes/check', () =>
        HttpResponse.json({ needsInviteCode: false }),
      ),
    );
    act(() => window.dispatchEvent(new CustomEvent(AUTH_SESSION_CHANGED_EVENT)));
    expect(await screen.findByRole('button', { name: 'Accept invitation' })).toBeInTheDocument();
    expect(api.writes).toHaveLength(0);
  });
});
