/**
 * Blackbox tests for Granola on the Integrations page (stock cards and the
 * Rose Desktop row list). Connect is one click: the backend returns Granola's
 * sign-in URL and the browser goes there.
 *
 *   - web: Connect POSTs /oauth/start with this page as the return URL and
 *     navigates to the returned Granola sign-in URL
 *   - Mac app: Connect opens the sign-in URL in the system browser, then polls
 *     until the backend reports Granola connected and shows the meeting count
 *   - Rose Desktop row: shows the signed-in account and disconnects from its chip
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import Integrations from '@/pages/Integrations';

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
      { returnUrl: originalLocation.origin + originalLocation.pathname },
    ]);
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
    expect(backend.starts).toEqual([{}]);
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
