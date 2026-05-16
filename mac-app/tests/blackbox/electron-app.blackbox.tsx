/**
 * Blackbox coverage for the renderer entry `ui/ElectronApp.tsx`.
 *
 * The ElectronApp shell decides which top-level view the user sees:
 *   auth loading  → loading spinner
 *   not signed in → Onboarding (starts at auth step)
 *   signed in + not onboarded → Onboarding (skipAuth, starts after auth)
 *   signed in + onboarded → Terminal (router outlet) via HashRouter
 *
 * It also talks to two backend endpoints:
 *   GET  /api/user-settings             — read onboardingCompletedAt
 *   POST /api/auth/complete-onboarding  — mark onboarding done after Onboarding finishes
 *
 * These tests drive only the observable contract:
 *   - Which top-level view renders given (authLoading, isFullySignedIn, onboardingCompletedAt)
 *   - Which backend calls are captured (URL / method / auth header)
 *   - Error path does not crash the shell (graceful UI)
 *
 * Heavy children (`@/pages/Terminal`, Onboarding step pages, AppDataProvider,
 * Supabase-backed `useAuth`, etc.) are stubbed via `vi.mock` so the tests stay
 * focused on ElectronApp routing logic. The only network boundary we exercise
 * is the backend HTTP surface, via MSW (same harness as other renderer tests).
 */

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, waitFor, render, act, fireEvent } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { installIpcMock } from './ipc-mock';

// ---- Mock seams (declared before importing ElectronApp so vi.mock hoists) ----

interface MockAuthState {
  isFullySignedIn: boolean;
  isAnonymous: boolean;
  loading: boolean;
  refreshAuthState: (reason: string) => Promise<void>;
}

const authState: MockAuthState = {
  isFullySignedIn: false,
  isAnonymous: false,
  loading: true,
  refreshAuthState: vi.fn(async () => {}),
};
let mockSessionToken: string | null = null;

vi.mock('@/features/auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/supabase', () => ({
  getSession: () => (mockSessionToken ? { access_token: mockSessionToken } : null),
  signOut: vi.fn(async () => {}),
}));

vi.mock('@/hooks/useAppData', () => ({
  AppDataProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ErrorBoundary', () => ({
  default: ({ children }: { children: React.ReactNode; name?: string }) => <>{children}</>,
}));

vi.mock('@/pages/Terminal', () => ({
  default: () => <div data-testid="terminal-page">terminal</div>,
}));
vi.mock('@/pages/Privacy', () => ({
  default: () => <div data-testid="privacy-page">privacy</div>,
}));
vi.mock('@/pages/Terms', () => ({
  default: () => <div data-testid="terms-page">terms</div>,
}));
vi.mock('@/pages/NotFound', () => ({
  default: () => <div data-testid="notfound-page">not found</div>,
}));

// Replace the local Onboarding screen with a testable stub that exposes
// isSignedIn / skipAuth and lets us fire onComplete deterministically.
interface OnboardingProps {
  onComplete: () => void;
  isSignedIn?: boolean;
  skipAuth?: boolean;
}
vi.mock('../../ui/onboarding/Onboarding', () => ({
  default: ({ onComplete, isSignedIn, skipAuth }: OnboardingProps) => (
    <div data-testid="onboarding-view">
      <div data-testid="onboarding-skip-auth">{skipAuth ? 'skip-auth' : 'with-auth'}</div>
      <div data-testid="onboarding-is-signed-in">{isSignedIn ? 'signed-in' : 'signed-out'}</div>
      <button type="button" onClick={onComplete}>
        finish-onboarding
      </button>
    </div>
  ),
}));

// Import after mocks are registered.
import ElectronApp from '../../ui/ElectronApp';

// ---------------------------- helpers ---------------------------------------

const BACKEND_URL = 'http://localhost:3001';

function setAuth(next: Partial<MockAuthState>): void {
  Object.assign(authState, next);
}

function resetAuth(): void {
  setAuth({
    isFullySignedIn: false,
    isAnonymous: false,
    loading: true,
    refreshAuthState: vi.fn(async () => {}),
  });
  mockSessionToken = null;
}

function userSettingsHandler(body: unknown, status = 200) {
  return http.get(`${BACKEND_URL}/api/user-settings`, () =>
    HttpResponse.json(body as Record<string, unknown>, { status })
  );
}

function completeOnboardingHandler(body: unknown = { ok: true }) {
  return http.post(`${BACKEND_URL}/api/auth/complete-onboarding`, () =>
    HttpResponse.json(body as Record<string, unknown>)
  );
}

// -------------------------------- tests -------------------------------------

describe('electron-app blackbox', () => {
  beforeEach(() => {
    clearCaptures();
    resetAuth();
    installIpcMock({});
  });

  it('renders loading spinner while auth is resolving (no backend call yet)', async () => {
    setAuth({ loading: true, isFullySignedIn: false });

    const { container } = render(<ElectronApp />);

    // Spinner is the only thing on screen; onboarding/terminal are not mounted.
    expect(container.querySelector('.animate-spin')).not.toBeNull();
    expect(screen.queryByTestId('onboarding-view')).toBeNull();
    expect(screen.queryByTestId('terminal-page')).toBeNull();

    // And no backend call has been made yet.
    expect(capturedRequests.filter((r) => r.url.includes('/api/user-settings'))).toHaveLength(0);

    await waitFor(() => {
      expect(container.querySelector('.animate-spin')).not.toBeNull();
      expect(screen.queryByTestId('onboarding-view')).toBeNull();
      expect(screen.queryByTestId('terminal-page')).toBeNull();
      expect(capturedRequests.filter((r) => r.url.includes('/api/user-settings'))).toHaveLength(0);
    });
  });

  it('unauthenticated user lands on Onboarding with auth step (no backend call)', async () => {
    setAuth({ loading: false, isFullySignedIn: false, isAnonymous: true });

    render(<ElectronApp />);

    const onboarding = await screen.findByTestId('onboarding-view');
    expect(onboarding).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-skip-auth')).toHaveTextContent('with-auth');
    expect(screen.getByTestId('onboarding-is-signed-in')).toHaveTextContent('signed-out');

    // Shell short-circuits without hitting /api/user-settings when signed out.
    expect(capturedRequests.filter((r) => r.url.includes('/api/user-settings'))).toHaveLength(0);
  });

  it('authed + not onboarded → Onboarding with skipAuth, captures Bearer /api/user-settings GET', async () => {
    mockSessionToken = 'test-access-token';
    setAuth({ loading: false, isFullySignedIn: true });
    server.use(userSettingsHandler({ onboardingCompletedAt: null }));

    render(<ElectronApp />);

    const onboarding = await screen.findByTestId('onboarding-view');
    expect(onboarding).toBeInTheDocument();
    expect(screen.getByTestId('onboarding-skip-auth')).toHaveTextContent('skip-auth');
    expect(screen.getByTestId('onboarding-is-signed-in')).toHaveTextContent('signed-in');

    // Boundary: one GET /api/user-settings with the session access token.
    await waitFor(() => {
      expect(capturedRequests.find((r) => r.url.includes('/api/user-settings'))).toBeDefined();
    });

    const req = capturedRequests.find((r) => r.url.includes('/api/user-settings'));
    expect(req).toBeDefined();
    expect(req?.method).toBe('GET');
    expect(req?.headers.authorization).toBe('Bearer test-access-token');
  });

  it('authed + already onboarded → Terminal view (router default route)', async () => {
    mockSessionToken = 'done-token';
    setAuth({ loading: false, isFullySignedIn: true });
    server.use(userSettingsHandler({ onboardingCompletedAt: '2025-01-01T00:00:00Z' }));

    render(<ElectronApp />);

    expect(await screen.findByTestId('terminal-page')).toBeInTheDocument();
    expect(screen.queryByTestId('onboarding-view')).toBeNull();
  });

  it('backend error on user-settings → shell falls back to Onboarding (graceful, no crash)', async () => {
    mockSessionToken = 'boom-token';
    setAuth({ loading: false, isFullySignedIn: true });
    server.use(userSettingsHandler({ error: 'boom' }, 500));

    render(<ElectronApp />);

    expect(await screen.findByTestId('onboarding-view')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-page')).toBeNull();
  });

  it('finishing onboarding POSTs /api/auth/complete-onboarding with Bearer + JSON content-type', async () => {
    mockSessionToken = 'finish-token';
    const refreshAuthState = vi.fn(async () => {});
    setAuth({ loading: false, isFullySignedIn: true, refreshAuthState });
    server.use(
      userSettingsHandler({ onboardingCompletedAt: null }),
      completeOnboardingHandler({ ok: true })
    );

    render(<ElectronApp />);

    const finishBtn = await screen.findByRole('button', { name: 'finish-onboarding' });
    await act(async () => {
      fireEvent.click(finishBtn);
    });

    await waitFor(() => {
      expect(
        capturedRequests.find((r) => r.url.includes('/api/auth/complete-onboarding'))
      ).toBeDefined();
    });

    const post = capturedRequests.find((r) => r.url.includes('/api/auth/complete-onboarding'));
    expect(post).toBeDefined();
    expect(post?.method).toBe('POST');
    expect(post?.headers.authorization).toBe('Bearer finish-token');
    expect(post?.headers['content-type']).toContain('application/json');

    // Shell also asks auth layer to refresh after onboarding completes.
    await waitFor(() => {
      expect(refreshAuthState).toHaveBeenCalledWith('onboarding-complete');
    });
  });
});
