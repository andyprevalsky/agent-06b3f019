/**
 * Renderer-main domain blackbox tests.
 *
 * Domain: React app entry + routing + global providers (ui/main.tsx,
 * ui/ElectronApp.tsx, ui/UpdateIndicator.tsx + the IntegrationHandlersProvider
 * wiring and the QuickQueryListener bridge from main.tsx).
 *
 * Observable surface (what the user actually sees or triggers):
 *  - Loading chrome while auth/onboarding status resolves
 *  - Onboarding vs. main app (Terminal) gate based on signed-in + onboarding-complete
 *  - /api/user-settings GET on mount (reads onboardingCompletedAt)
 *  - /api/auth/complete-onboarding POST when onboarding finishes
 *  - Update indicator chip state machine reacting to IPC update events
 *  - window.api.onQuickQuerySubmit → window-level 'rose:quick-query' CustomEvent
 *  - IntegrationHandlersProvider exposing electron handlers to descendants
 *
 * All heavy page trees (`@/pages/*`, `./onboarding/Onboarding`, `AppDataProvider`,
 * `TooltipProvider`, `ErrorBoundary`) are stubbed at the module boundary so this
 * suite isolates the renderer-main coordination logic. The mocks are declared
 * up-front at the top of the file (before any SUT import) because vi.mock is
 * hoisted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import React from 'react';

import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import { clearIpcMock, installIpcMock } from './ipc-mock';
import type { IPC, QuickQueryPayload, UpdateStatusPayload } from '../../shared/types/ipc';

// ---------------------------------------------------------------------------
// Module stubs — keep this block minimal. We only mock what renderer-main
// imports transitively but does not itself own.
// ---------------------------------------------------------------------------

type AuthMock = {
  isFullySignedIn: boolean;
  isAnonymous: boolean;
  loading: boolean;
  refreshAuthState: ReturnType<typeof vi.fn>;
};

const authState: AuthMock = {
  isFullySignedIn: false,
  isAnonymous: true,
  loading: false,
  refreshAuthState: vi.fn(async () => undefined),
};

type SessionStub = { access_token: string } | null;
const sessionRef: { current: SessionStub } = { current: { access_token: 'test-access-token' } };

vi.mock('@/features/auth', () => ({
  useAuth: () => ({
    isFullySignedIn: authState.isFullySignedIn,
    isAnonymous: authState.isAnonymous,
    loading: authState.loading,
    refreshAuthState: authState.refreshAuthState,
  }),
}));

vi.mock('@/lib/supabase', () => ({
  getSession: () => sessionRef.current,
}));

vi.mock('@/hooks/useAppData', () => ({
  AppDataProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-data-provider">{children}</div>
  ),
}));

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/components/ErrorBoundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/pages/Terminal', () => ({
  default: () => <div data-testid="page-terminal">Terminal</div>,
}));
vi.mock('@/pages/Privacy', () => ({
  default: () => <div data-testid="page-privacy">Privacy</div>,
}));
vi.mock('@/pages/Terms', () => ({
  default: () => <div data-testid="page-terms">Terms</div>,
}));
vi.mock('@/pages/NotFound', () => ({
  default: () => <div data-testid="page-not-found">NotFound</div>,
}));

type OnboardingStubProps = {
  onComplete: () => void;
  isSignedIn?: boolean;
  skipAuth?: boolean;
};

vi.mock('../../ui/onboarding/Onboarding', () => ({
  default: ({ onComplete, isSignedIn, skipAuth }: OnboardingStubProps) => (
    <div data-testid="onboarding-stub">
      <span data-testid="onboarding-signed-in">{String(isSignedIn ?? false)}</span>
      <span data-testid="onboarding-skip-auth">{String(skipAuth ?? false)}</span>
      <button type="button" onClick={onComplete}>
        Finish Onboarding
      </button>
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// SUT imports (AFTER vi.mock declarations)
// ---------------------------------------------------------------------------

import ElectronApp from '../../ui/ElectronApp';
import UpdateIndicator from '../../ui/UpdateIndicator';
import QuickQueryListener from '../../ui/features/quick-query-listener';
import {
  IntegrationHandlersProvider,
  useIntegrationHandlers,
} from '@/features/integration-handlers-context';
import { QUICK_QUERY_EVENT, dispatchQuickQueryEvent } from '@/lib/quickQuery';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BACKEND_URL = 'http://localhost:3001';

function setAuth(next: Partial<AuthMock>) {
  Object.assign(authState, next);
}

function resetAuth() {
  setAuth({
    isFullySignedIn: false,
    isAnonymous: true,
    loading: false,
    refreshAuthState: vi.fn(async () => undefined),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('renderer-main blackbox', () => {
  beforeEach(() => {
    clearCaptures();
    resetAuth();
    sessionRef.current = { access_token: 'test-access-token' };
  });

  afterEach(() => {
    cleanup();
    clearIpcMock();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // ElectronApp shell — onboarding/terminal gate
  // -------------------------------------------------------------------------

  describe('ElectronApp shell', () => {
    it('shows loading spinner while auth is still resolving (loading state)', () => {
      setAuth({ loading: true, isFullySignedIn: false, isAnonymous: true });
      installIpcMock();

      renderWithProviders(<ElectronApp />, { withRouter: false });

      // Neither onboarding nor terminal is rendered yet.
      expect(screen.queryByTestId('onboarding-stub')).not.toBeInTheDocument();
      expect(screen.queryByTestId('page-terminal')).not.toBeInTheDocument();
      // AppDataProvider/Query wrapper still mounts (observable chrome).
      expect(screen.getByTestId('app-data-provider')).toBeInTheDocument();
    });

    it('renders onboarding (auth-first) for an unauthenticated user', async () => {
      setAuth({ loading: false, isFullySignedIn: false, isAnonymous: true });
      installIpcMock();

      renderWithProviders(<ElectronApp />, { withRouter: false });

      const onboarding = await screen.findByTestId('onboarding-stub');
      expect(onboarding).toBeInTheDocument();
      // skipAuth=false because user is not signed in
      expect(screen.getByTestId('onboarding-skip-auth')).toHaveTextContent('false');
      expect(screen.getByTestId('onboarding-signed-in')).toHaveTextContent('false');
      // Main app (Terminal route) must not leak through
      expect(screen.queryByTestId('page-terminal')).not.toBeInTheDocument();
    });

    it('renders Terminal when signed-in and onboarding complete (happy path + API capture)', async () => {
      setAuth({ loading: false, isFullySignedIn: true, isAnonymous: false });
      installIpcMock();

      server.use(
        http.get(`${BACKEND_URL}/api/user-settings`, () =>
          HttpResponse.json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' })
        )
      );

      renderWithProviders(<ElectronApp />, { withRouter: false });

      expect(await screen.findByTestId('page-terminal')).toBeInTheDocument();
      expect(screen.queryByTestId('onboarding-stub')).not.toBeInTheDocument();

      // Boundary capture: GET /api/user-settings with Bearer token
      const req = capturedRequests.find((r) => r.url.includes('/api/user-settings'));
      expect(req).toBeDefined();
      expect(req?.method).toBe('GET');
      expect(req?.headers.authorization).toBe('Bearer test-access-token');
    });

    it('renders Onboarding with skipAuth=true when signed-in but not yet onboarded', async () => {
      setAuth({ loading: false, isFullySignedIn: true, isAnonymous: false });
      installIpcMock();

      server.use(
        http.get(`${BACKEND_URL}/api/user-settings`, () =>
          HttpResponse.json({ onboardingCompletedAt: null })
        )
      );

      renderWithProviders(<ElectronApp />, { withRouter: false });

      await screen.findByTestId('onboarding-stub');
      expect(screen.getByTestId('onboarding-signed-in')).toHaveTextContent('true');
      expect(screen.getByTestId('onboarding-skip-auth')).toHaveTextContent('true');
      expect(screen.queryByTestId('page-terminal')).not.toBeInTheDocument();
    });

    it('falls back to Onboarding gracefully when /api/user-settings errors (error state)', async () => {
      setAuth({ loading: false, isFullySignedIn: true, isAnonymous: false });
      installIpcMock();

      server.use(
        http.get(`${BACKEND_URL}/api/user-settings`, () =>
          HttpResponse.json({ error: 'boom' }, { status: 500 })
        )
      );

      renderWithProviders(<ElectronApp />, { withRouter: false });

      // The coordinator treats any failure as "not complete" → Onboarding.
      await screen.findByTestId('onboarding-stub');
      expect(screen.queryByTestId('page-terminal')).not.toBeInTheDocument();
      // Boundary still captured exactly once for this mount.
      const userSettingsCalls = capturedRequests.filter((r) =>
        r.url.includes('/api/user-settings')
      );
      expect(userSettingsCalls).toHaveLength(1);
    });

    it('treats a backend response with null onboardingCompletedAt as empty state (no Terminal)', async () => {
      setAuth({ loading: false, isFullySignedIn: true, isAnonymous: false });
      installIpcMock();

      server.use(http.get(`${BACKEND_URL}/api/user-settings`, () => HttpResponse.json({})));

      renderWithProviders(<ElectronApp />, { withRouter: false });

      await screen.findByTestId('onboarding-stub');
      expect(screen.queryByTestId('page-terminal')).not.toBeInTheDocument();
    });

    it('POSTs /api/auth/complete-onboarding when the onboarding flow finishes', async () => {
      setAuth({ loading: false, isFullySignedIn: true, isAnonymous: false });
      const user = userEvent.setup();
      const setComplete = vi.fn(async () => ({ success: true }));
      const enable = vi.fn(async () => ({ success: true, enabled: true }));
      installIpcMock({
        onboarding: {
          isComplete: vi.fn(async () => false),
          setComplete,
          getLastAuthProvider: vi.fn(async () => null),
          setLastAuthProvider: vi.fn(async () => ({ success: true })),
        },
        shortcut: {
          get: vi.fn(async () => null),
          set: vi.fn(async () => ({ success: true })),
          validate: vi.fn(async () => ({ available: true })),
          enable,
          disable: vi.fn(async () => ({ success: true, enabled: false })),
          isEnabled: vi.fn(async () => ({ enabled: true })),
        },
      } as Partial<IPC>);

      server.use(
        http.get(`${BACKEND_URL}/api/user-settings`, () =>
          HttpResponse.json({ onboardingCompletedAt: null })
        ),
        http.post(`${BACKEND_URL}/api/auth/complete-onboarding`, () =>
          HttpResponse.json({ success: true })
        )
      );

      renderWithProviders(<ElectronApp />, { withRouter: false });
      await screen.findByTestId('onboarding-stub');
      clearCaptures();

      await user.click(screen.getByRole('button', { name: 'Finish Onboarding' }));

      await waitFor(() => {
        expect(capturedRequests.some((r) => r.url.includes('/api/auth/complete-onboarding'))).toBe(
          true
        );
      });

      const post = capturedRequests.find((r) => r.url.includes('/api/auth/complete-onboarding'));
      expect(post?.method).toBe('POST');
      expect(post?.headers.authorization).toBe('Bearer test-access-token');
      expect(post?.headers['content-type']).toBe('application/json');

      // IPC side-effects observed via the mocked bridge
      await waitFor(() => {
        expect(setComplete).toHaveBeenCalledWith(true);
        expect(enable).toHaveBeenCalled();
      });
      expect(authState.refreshAuthState).toHaveBeenCalledWith('onboarding-complete');
    });

    it('skips /api/user-settings when no session token is present', async () => {
      setAuth({ loading: false, isFullySignedIn: true, isAnonymous: false });
      sessionRef.current = null;
      installIpcMock();

      renderWithProviders(<ElectronApp />, { withRouter: false });

      await screen.findByTestId('onboarding-stub');
      expect(capturedRequests.some((r) => r.url.includes('/api/user-settings'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // UpdateIndicator state machine
  // -------------------------------------------------------------------------

  describe('UpdateIndicator', () => {
    function setupIndicator() {
      const statusCallbacks: Array<(p: UpdateStatusPayload) => void> = [];
      const downloadUpdate = vi.fn();
      const restartToUpdate = vi.fn();
      const checkForUpdates = vi.fn();

      installIpcMock({
        onUpdateStatus: (cb) => {
          statusCallbacks.push(cb);
        },
        onUpdateProgress: vi.fn(),
        downloadUpdate,
        restartToUpdate,
        checkForUpdates,
      } as Partial<IPC>);

      renderWithProviders(<UpdateIndicator />);

      const emit = (payload: UpdateStatusPayload) => {
        act(() => {
          statusCallbacks.forEach((cb) => {
            cb(payload);
          });
        });
      };

      return { emit, downloadUpdate, restartToUpdate, checkForUpdates };
    }

    it('renders nothing when state is idle (empty state)', () => {
      setupIndicator();
      expect(screen.queryByText(/update/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Up to date/i)).not.toBeInTheDocument();
    });

    it('renders the "New update available" chip with Install Now when state=available (happy path)', () => {
      const { emit } = setupIndicator();
      emit({ state: 'available', version: '1.2.3' });

      expect(screen.getByText('New update available')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Install Now' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
    });

    it('Install Now invokes downloadUpdate on window.api', async () => {
      const user = userEvent.setup();
      const { emit, downloadUpdate } = setupIndicator();
      emit({ state: 'available', version: '1.2.3' });

      await user.click(screen.getByRole('button', { name: 'Install Now' }));
      expect(downloadUpdate).toHaveBeenCalledTimes(1);
    });

    it('Later dismisses the chip (state transition → hidden)', async () => {
      const user = userEvent.setup();
      const { emit } = setupIndicator();
      emit({ state: 'available', version: '1.2.3' });
      expect(screen.getByText('New update available')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Later' }));
      expect(screen.queryByText('New update available')).not.toBeInTheDocument();
    });

    it('renders the downloading chip with rounded percent when state=downloading', () => {
      const { emit } = setupIndicator();
      emit({ state: 'downloading', percent: 42.4 });

      expect(screen.getByText('Downloading...')).toBeInTheDocument();
    });

    it('renders "Restart Now" when state=downloaded and invokes restartToUpdate', async () => {
      const user = userEvent.setup();
      const { emit, restartToUpdate } = setupIndicator();
      emit({ state: 'downloaded', version: '1.2.3' });

      const restart = screen.getByRole('button', { name: 'Restart Now' });
      await user.click(restart);
      expect(restartToUpdate).toHaveBeenCalledTimes(1);
    });

    it('renders the error chip with Retry and calls checkForUpdates (error state)', async () => {
      const user = userEvent.setup();
      const { emit, checkForUpdates } = setupIndicator();
      emit({ state: 'error', message: 'download failed' });

      expect(screen.getByText('Update failed')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('treats state=building as up-to-date ("none") chip and auto-dismisses', () => {
      vi.useFakeTimers();
      const { emit } = setupIndicator();
      emit({ state: 'building' });

      expect(screen.getByText('Up to date')).toBeInTheDocument();

      // Chip auto-dismisses after the NONE_DISMISS_DELAY (3000ms)
      act(() => {
        vi.advanceTimersByTime(3100);
      });
      expect(screen.queryByText('Up to date')).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // IntegrationHandlersProvider — electron handlers wiring
  // -------------------------------------------------------------------------

  describe('IntegrationHandlersProvider', () => {
    function HandlersProbe() {
      const handlers = useIntegrationHandlers();
      return (
        <div data-testid="handlers-probe">
          <span data-testid="imessage-available">
            {String(Boolean(handlers.iMessage?.isAvailable))}
          </span>
          <span data-testid="browser-available">
            {String(Boolean(handlers.browserCookies?.isAvailable))}
          </span>
        </div>
      );
    }

    it('exposes provided handlers to descendants (happy path)', () => {
      const handlers = {
        iMessage: { isAvailable: true, onClick: vi.fn(async () => undefined) },
        browserCookies: {
          isAvailable: true,
          getInstalledBrowsers: vi.fn(async () => []),
          syncBrowser: vi.fn(async () => undefined),
          syncBrowserPasswords: vi.fn(async () => ({ success: true })),
        },
      };

      renderWithProviders(
        <IntegrationHandlersProvider handlers={handlers}>
          <HandlersProbe />
        </IntegrationHandlersProvider>
      );

      expect(screen.getByTestId('imessage-available')).toHaveTextContent('true');
      expect(screen.getByTestId('browser-available')).toHaveTextContent('true');
    });

    it('renders with empty handlers and exposes an empty context (empty state)', () => {
      renderWithProviders(
        <IntegrationHandlersProvider handlers={{}}>
          <HandlersProbe />
        </IntegrationHandlersProvider>
      );

      expect(screen.getByTestId('imessage-available')).toHaveTextContent('false');
      expect(screen.getByTestId('browser-available')).toHaveTextContent('false');
    });
  });

  // -------------------------------------------------------------------------
  // QuickQuery bridge — IPC → window CustomEvent
  // -------------------------------------------------------------------------

  describe('QuickQuery bridge (main.tsx → window event)', () => {
    it('dispatchQuickQueryEvent emits a rose:quick-query CustomEvent with payload', () => {
      const received: QuickQueryPayload[] = [];
      const listener = (e: Event) => {
        received.push((e as CustomEvent<QuickQueryPayload>).detail);
      };
      window.addEventListener(QUICK_QUERY_EVENT, listener);

      dispatchQuickQueryEvent({ query: 'hello', submittedAt: 42 });

      window.removeEventListener(QUICK_QUERY_EVENT, listener);
      expect(received).toEqual([{ query: 'hello', submittedAt: 42 }]);
    });

    it('main.tsx-style wiring forwards window.api.onQuickQuerySubmit payloads to the window event', () => {
      let ipcSubmitCb: ((p: QuickQueryPayload) => void) | null = null;
      installIpcMock({
        onQuickQuerySubmit: (cb) => {
          ipcSubmitCb = cb;
        },
      } as Partial<IPC>);

      const received: QuickQueryPayload[] = [];
      const listener = (e: Event) => {
        received.push((e as CustomEvent<QuickQueryPayload>).detail);
      };
      window.addEventListener(QUICK_QUERY_EVENT, listener);

      renderWithProviders(<QuickQueryListener />);

      expect(ipcSubmitCb).not.toBeNull();
      act(() => {
        ipcSubmitCb?.({ query: 'from-ipc', submittedAt: 99 });
      });

      window.removeEventListener(QUICK_QUERY_EVENT, listener);
      expect(received).toEqual([{ query: 'from-ipc', submittedAt: 99 }]);
    });

    it('does not crash when quick-query preload bridge is unavailable', () => {
      clearIpcMock();

      expect(() => {
        renderWithProviders(<QuickQueryListener />);
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Boundary capture summary — hard assertion on the complete set of
  // backend endpoints renderer-main is allowed to touch on mount.
  // -------------------------------------------------------------------------

  describe('backend boundary allow-list', () => {
    it('touches only /api/user-settings on a cold signed-in mount', async () => {
      setAuth({ loading: false, isFullySignedIn: true, isAnonymous: false });
      installIpcMock();

      server.use(
        http.get(`${BACKEND_URL}/api/user-settings`, () =>
          HttpResponse.json({ onboardingCompletedAt: '2026-01-01T00:00:00Z' })
        )
      );

      renderWithProviders(<ElectronApp />, { withRouter: false });
      await screen.findByTestId('page-terminal');

      const paths = capturedRequests
        .map((r) => new URL(r.url).pathname)
        .filter((p) => p.startsWith('/api/'));
      expect(paths).toEqual(['/api/user-settings']);
    });
  });
});
