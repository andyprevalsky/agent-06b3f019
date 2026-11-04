/**
 * Blackbox tests for Granola on the Integrations page (stock cards and the
 * Rose Desktop row list). Connect is one click: the backend returns Granola's
 * sign-in URL and the browser goes there.
 *
 *   - web: Connect POSTs /oauth/start with this origin's callback page,
 *     remembers the current page and navigates to the Granola sign-in URL
 *   - Mac app: Connect opens the sign-in URL in the system browser (returning
 *     to the public site's callback), then polls until the backend reports
 *     Granola connected and shows the meeting count
 *   - Mac app reconnect from EXPIRED keeps polling until the new grant lands
 *   - a slow older status read never overwrites a newer one
 *   - callback page: posts Granola's code and state with the user's own session
 *     and returns to the remembered page; a refusal or Granola error is shown
 *   - status is re-read while history backfills, not once the sign-in expired
 *   - Rose Desktop row: shows the signed-in account and disconnects from its chip
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import Integrations from '@/pages/Integrations';
import { GranolaCallback } from '@/features/integrations/components';

const API_BASE = 'http://localhost:3001/api';
const AUTHORIZE_URL = 'https://mcp-auth.granola.ai/oauth2/authorize?client_id=c&state=s';

function mockSession() {
  const session = {
    access_token: 'test-token',
    refresh_token: 'test-refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'test-user', is_anonymous: false }));
}

function status(connected: boolean, meetings = 0) {
  return {
    connected,
    status: connected ? 'CONNECTED' : 'NOT_CONNECTED',
    accountEmail: connected ? 'andy@example.com' : null,
    backfillDone: connected,
    lastSuccessfulSyncAt: null,
    lastError: null,
    documents: connected ? { granola_note: meetings, granola_transcript: meetings } : {},
  };
}

/** A stateful Granola backend; `connected` flips when the test says sign-in finished. */
function granolaBackend() {
  const state = { connected: false, starts: [] as unknown[], deletes: 0 };
  server.use(
    http.get(`${API_BASE}/integrations/granola`, () =>
      HttpResponse.json(status(state.connected, 4)),
    ),
    http.get(`${API_BASE}/integrations`, () =>
      HttpResponse.json({
        integrations: state.connected
          ? [
              {
                id: 'integration-granola',
                name: 'granola',
                type: 'DATA_SOURCE',
                status: 'CONNECTED',
                isActive: true,
              },
            ]
          : [],
      }),
    ),
    http.post(`${API_BASE}/integrations/granola/oauth/start`, async ({ request }) => {
      state.starts.push(await request.json());
      return HttpResponse.json({ authorizeUrl: AUTHORIZE_URL });
    }),
    http.delete(`${API_BASE}/integrations/granola`, () => {
      state.deletes += 1;
      state.connected = false;
      return HttpResponse.json({ deletedDocuments: 12 });
    }),
  );
  return state;
}

describe('Granola integration', () => {
  const originalLocation = window.location;

  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    delete window.api;
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('web: one click sends the browser to Granola sign-in', async () => {
    const backend = granolaBackend();
    const location = { ...originalLocation, href: originalLocation.href };
    Object.defineProperty(window, 'location', { configurable: true, value: location });
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Connect Granola' }));
    await waitFor(() => expect(location.href).toBe(AUTHORIZE_URL));
    expect(backend.starts).toEqual([
      { redirectUri: `${originalLocation.origin}/integrations/granola/callback` },
    ]);
    expect(sessionStorage.getItem('rose.granola.returnPath')).toBe(
      originalLocation.pathname + originalLocation.search,
    );
  });

  it('Mac app: opens sign-in in the system browser and picks up the connection', async () => {
    const backend = granolaBackend();
    const openExternal = vi.fn(async () => {
      backend.connected = true;
    });
    window.api = { isElectron: true, openExternal };
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Connect Granola' }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(AUTHORIZE_URL));
    expect(await screen.findByText('4 meetings synced', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByText('andy@example.com')).toBeInTheDocument();
    expect(backend.starts).toEqual([
      { redirectUri: 'https://www.roselabs.ai/integrations/granola/callback' },
    ]);
  });

  it('Mac app: reconnecting an expired sign-in waits for the new grant', async () => {
    const backend = granolaBackend();
    backend.connected = true;
    let expired = true;
    server.use(
      http.get(`${API_BASE}/integrations/granola`, () =>
        HttpResponse.json({ ...status(true, 4), ...(expired ? { status: 'EXPIRED' } : {}) }),
      ),
    );
    const openExternal = vi.fn(async () => {
      setTimeout(() => {
        expired = false;
      }, 4_500);
    });
    window.api = { isElectron: true, openExternal };
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Reconnect Granola' }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(AUTHORIZE_URL));
    expect(await screen.findByText('4 meetings synced', {}, { timeout: 9000 })).toBeInTheDocument();
  }, 15_000);

  it('Mac app: a slow older status read never restores EXPIRED', async () => {
    const backend = granolaBackend();
    backend.connected = true;
    let reads = 0;
    server.use(
      http.get(`${API_BASE}/integrations/granola`, async () => {
        reads += 1;
        // Read 2 (first sign-in poll) is slow and still EXPIRED; read 3 sees the new grant.
        if (reads === 2) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          return HttpResponse.json({ ...status(true, 4), status: 'EXPIRED' });
        }
        return HttpResponse.json(
          reads === 1 ? { ...status(true, 4), status: 'EXPIRED' } : status(true, 4),
        );
      }),
    );
    window.api = { isElectron: true, openExternal: vi.fn(async () => undefined) };
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Reconnect Granola' }));
    expect(await screen.findByText('4 meetings synced', {}, { timeout: 9000 })).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(screen.getByText('4 meetings synced')).toBeInTheDocument();
    expect(screen.queryByText(/Granola sign-in expired/)).not.toBeInTheDocument();
  }, 20_000);

  it('polls while history backfills, and stops once the sign-in has expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      let current = { ...status(true, 4), backfillDone: false };
      server.use(
        http.get(`${API_BASE}/integrations/granola`, () => {
          reads += 1;
          return HttpResponse.json(current);
        }),
      );
      renderWithProviders(<Integrations />, { roseDesktop: false });
      expect(await screen.findByText(/importing older meetings/)).toBeInTheDocument();
      const start = reads;
      await vi.advanceTimersByTimeAsync(21_000);
      expect(reads).toBeGreaterThan(start);

      current = { ...current, status: 'EXPIRED' };
      await vi.advanceTimersByTimeAsync(11_000);
      expect(await screen.findByText(/Granola sign-in expired/)).toBeInTheDocument();
      const expired = reads;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(reads).toBe(expired);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stock card: disconnecting deletes the connection', async () => {
    const backend = granolaBackend();
    backend.connected = true;
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const user = userEvent.setup();

    expect(await screen.findByText('4 meetings synced')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Disconnect Granola and delete its synced notes' }),
    );
    await waitFor(() => expect(backend.deletes).toBe(1));
    expect(await screen.findByRole('button', { name: 'Connect Granola' })).toBeInTheDocument();
  });

  it('Rose Desktop: the row shows the account and disconnects from its chip', async () => {
    const backend = granolaBackend();
    backend.connected = true;
    renderWithProviders(<Integrations />);
    const user = userEvent.setup();

    const row = await screen.findByTestId('integration-row-granola');
    await waitFor(() =>
      expect(within(row).getByTestId('accounts-granola')).toHaveTextContent('andy@example.com'),
    );
    await user.click(within(row).getByRole('button', { name: 'Disconnect Granola' }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(backend.deletes).toBe(1));
    expect(
      await within(screen.getByTestId('integration-row-granola')).findByRole('button', {
        name: 'Connect Granola',
      }),
    ).toBeInTheDocument();
  });
});

describe('Granola sign-in callback page', () => {
  const originalLocation = window.location;

  function at(search: string) {
    const replace = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, search, replace },
    });
    return replace;
  }

  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('finishes sign-in with the code and state and returns to the starting page', async () => {
    const completes: unknown[] = [];
    server.use(
      http.post(`${API_BASE}/integrations/granola/oauth/complete`, async ({ request }) => {
        completes.push(await request.json());
        return HttpResponse.json(status(true, 0));
      }),
    );
    sessionStorage.setItem('rose.granola.returnPath', '/integrations?tab=data');
    const replace = at('?code=abc&state=user.nonce');
    renderWithProviders(<GranolaCallback />, { roseDesktop: false });

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/integrations?tab=data'));
    expect(completes).toEqual([{ code: 'abc', state: 'user.nonce' }]);
    expect(sessionStorage.getItem('rose.granola.returnPath')).toBeNull();
  });

  it('shows why a refused sign-in did not connect', async () => {
    server.use(
      http.post(`${API_BASE}/integrations/granola/oauth/complete`, () =>
        HttpResponse.json(
          { error: 'STATE_INVALID', message: 'Unknown or already used Granola sign-in' },
          { status: 400 },
        ),
      ),
    );
    const replace = at('?code=abc&state=other.nonce');
    renderWithProviders(<GranolaCallback />, { roseDesktop: false });

    expect(await screen.findByText('Unknown or already used Granola sign-in')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('shows a Granola error without calling the backend', async () => {
    let calls = 0;
    server.use(
      http.post(`${API_BASE}/integrations/granola/oauth/complete`, () => {
        calls += 1;
        return HttpResponse.json({});
      }),
    );
    at('?error=access_denied');
    renderWithProviders(<GranolaCallback />, { roseDesktop: false });

    expect(await screen.findByText('Granola sign-in access_denied.')).toBeInTheDocument();
    expect(calls).toBe(0);
  });
});
