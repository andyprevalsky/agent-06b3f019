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
 *   - status reads never supersede each other; slow reads still finish sign-in, and
 *     sign-in gives up at its deadline even while a read hangs
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
import { GranolaCallback, FirefliesCallback } from '@/features/integrations/components';

const API_BASE = 'http://localhost:3001/api';
const providers = [
  {
    provider: 'granola',
    name: 'Granola',
    authorizeUrl: 'https://mcp-auth.granola.ai/oauth2/authorize?client_id=c&state=s',
    Callback: GranolaCallback,
    document: 'granola_note',
  },
  {
    provider: 'fireflies',
    name: 'Fireflies',
    authorizeUrl: 'https://api.fireflies.ai/oauth/authorize?client_id=c&state=s',
    Callback: FirefliesCallback,
    document: 'fireflies_note',
  },
] as const;

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

function status(document: string, connected: boolean, meetings = 0) {
  return {
    connected,
    status: connected ? 'CONNECTED' : 'NOT_CONNECTED',
    accountEmail: connected ? 'andy@example.com' : null,
    backfillDone: connected,
    lastSuccessfulSyncAt: null,
    lastError: null,
    documents: connected ? { [document]: meetings } : {},
  };
}

/** A stateful Granola backend; `connected` flips when the test says sign-in finished. */
function granolaBackend(provider: string, document: string, authorizeUrl: string) {
  const state = { connected: false, starts: [] as unknown[], deletes: 0, syncs: 0 };
  server.use(
    http.get(`${API_BASE}/integrations/${provider}`, () =>
      HttpResponse.json(status(document, state.connected, 4)),
    ),
    http.get(`${API_BASE}/integrations`, () =>
      HttpResponse.json({
        integrations: state.connected
          ? [
              {
                id: `integration-${provider}`,
                name: provider,
                type: 'DATA_SOURCE',
                status: 'CONNECTED',
                isActive: true,
              },
            ]
          : [],
      }),
    ),
    http.post(`${API_BASE}/integrations/${provider}/oauth/start`, async ({ request }) => {
      state.starts.push(await request.json());
      return HttpResponse.json({ authorizeUrl: authorizeUrl });
    }),
    http.post(`${API_BASE}/integrations/${provider}/sync`, () => {
      state.syncs += 1;
      return HttpResponse.json(status(document, state.connected, 4));
    }),
    http.delete(`${API_BASE}/integrations/${provider}`, () => {
      state.deletes += 1;
      state.connected = false;
      return HttpResponse.json({ deletedDocuments: 12 });
    }),
  );
  return state;
}

describe.each(providers)('$name integration', ({ provider, name, authorizeUrl, document }) => {
  const originalLocation = window.location;

  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    delete window.api;
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('web: one click sends the browser to Granola sign-in', async () => {
    const backend = granolaBackend(provider, document, authorizeUrl);
    const location = { ...originalLocation, href: originalLocation.href };
    Object.defineProperty(window, 'location', { configurable: true, value: location });
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: `Connect ${name}` }));
    await waitFor(() => expect(location.href).toBe(authorizeUrl));
    expect(backend.starts).toEqual([
      { redirectUri: `${originalLocation.origin}/integrations/${provider}/callback` },
    ]);
    expect(sessionStorage.getItem(`rose.${provider}.returnPath`)).toBe(
      originalLocation.pathname + originalLocation.search,
    );
  });

  it('Mac app: opens sign-in in the system browser and picks up the connection', async () => {
    const backend = granolaBackend(provider, document, authorizeUrl);
    const openExternal = vi.fn(async () => {
      backend.connected = true;
    });
    window.api = { isElectron: true, openExternal };
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: `Connect ${name}` }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(authorizeUrl));
    expect(await screen.findByText('4 meetings synced', {}, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByText('andy@example.com')).toBeInTheDocument();
    expect(backend.starts).toEqual([
      { redirectUri: `https://www.roselabs.ai/integrations/${provider}/callback` },
    ]);
  });

  it('Mac app: reconnecting an expired sign-in waits for the new grant', async () => {
    const backend = granolaBackend(provider, document, authorizeUrl);
    backend.connected = true;
    let expired = true;
    server.use(
      http.get(`${API_BASE}/integrations/${provider}`, () =>
        HttpResponse.json({
          ...status(document, true, 4),
          ...(expired ? { status: 'EXPIRED' } : {}),
        }),
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

    await user.click(await screen.findByRole('button', { name: `Reconnect ${name}` }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(authorizeUrl));
    expect(await screen.findByText('4 meetings synced', {}, { timeout: 9000 })).toBeInTheDocument();
  }, 15_000);

  it('Mac app: sign-in completes even when every status read is slower than the poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const backend = granolaBackend(provider, document, authorizeUrl);
      backend.connected = true;
      let reads = 0;
      server.use(
        http.get(`${API_BASE}/integrations/${provider}`, async () => {
          reads += 1;
          const first = reads === 1;
          await new Promise((resolve) => setTimeout(resolve, first ? 0 : 4_000));
          return HttpResponse.json(
            first ? { ...status(document, true, 4), status: 'EXPIRED' } : status(document, true, 4),
          );
        }),
      );
      window.api = { isElectron: true, openExternal: vi.fn(async () => undefined) };
      renderWithProviders(<Integrations />, { roseDesktop: false });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      await user.click(await screen.findByRole('button', { name: `Reconnect ${name}` }));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await screen.findByText('4 meetings synced')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Mac app: sign-in gives up at its deadline even while a status read hangs', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const backend = granolaBackend(provider, document, authorizeUrl);
      backend.connected = true;
      let reads = 0;
      server.use(
        http.get(`${API_BASE}/integrations/${provider}`, async () => {
          reads += 1;
          // The first read answers; every later one hangs past the deadline.
          if (reads > 1) await new Promise((resolve) => setTimeout(resolve, 3_600_000));
          return HttpResponse.json({ ...status(document, true, 4), status: 'EXPIRED' });
        }),
      );
      window.api = { isElectron: true, openExternal: vi.fn(async () => undefined) };
      renderWithProviders(<Integrations />, { roseDesktop: false });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      const reconnect = await screen.findByRole('button', { name: `Reconnect ${name}` });
      await user.click(reconnect);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(screen.getByRole('button', { name: `Reconnect ${name}` })).toBeDisabled();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(screen.getByRole('button', { name: `Reconnect ${name}` })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Mac app: a slow older status read never restores EXPIRED', async () => {
    const backend = granolaBackend(provider, document, authorizeUrl);
    backend.connected = true;
    let reads = 0;
    server.use(
      http.get(`${API_BASE}/integrations/${provider}`, async () => {
        reads += 1;
        // Read 2 (first sign-in poll) is slow and still EXPIRED; read 3 sees the new grant.
        if (reads === 2) {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          return HttpResponse.json({ ...status(document, true, 4), status: 'EXPIRED' });
        }
        return HttpResponse.json(
          reads === 1
            ? { ...status(document, true, 4), status: 'EXPIRED' }
            : status(document, true, 4),
        );
      }),
    );
    window.api = { isElectron: true, openExternal: vi.fn(async () => undefined) };
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: `Reconnect ${name}` }));
    expect(
      await screen.findByText('4 meetings synced', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    await waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(screen.getByText('4 meetings synced')).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`${name} sign-in expired`))).not.toBeInTheDocument();
  }, 30_000);

  it('polls while history backfills, and stops once the sign-in has expired', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let reads = 0;
      let current = { ...status(document, true, 4), backfillDone: false };
      server.use(
        http.get(`${API_BASE}/integrations/${provider}`, () => {
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
      expect(await screen.findByText(new RegExp(`${name} sign-in expired`))).toBeInTheDocument();
      const expired = reads;
      await vi.advanceTimersByTimeAsync(31_000);
      expect(reads).toBe(expired);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    'search preserves connected status and sync actions (Rose Desktop=%s)',
    async (roseDesktop) => {
      const backend = granolaBackend(provider, document, authorizeUrl);
      backend.connected = true;
      renderWithProviders(<Integrations />, { roseDesktop });
      const user = userEvent.setup();
      await screen.findByText('andy@example.com');
      const input = screen.getByRole('searchbox', { name: 'Search integrations' });
      await user.type(input, 'impossible-match');
      expect(screen.queryByRole('button', { name: `Sync ${name} now` })).not.toBeInTheDocument();
      await user.clear(input);
      await user.type(input, provider.toUpperCase() + ' transcript');
      expect(screen.getByText('andy@example.com')).toBeVisible();
      await user.click(screen.getByRole('button', { name: `Sync ${name} now` }));
      await waitFor(() => expect(backend.syncs).toBe(1));
      expect(screen.getByText('andy@example.com')).toBeVisible();
    },
  );

  it('stock card: disconnecting deletes the connection', async () => {
    const backend = granolaBackend(provider, document, authorizeUrl);
    backend.connected = true;
    renderWithProviders(<Integrations />, { roseDesktop: false });
    const user = userEvent.setup();

    expect(await screen.findByText('4 meetings synced')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: `Disconnect ${name} and delete its synced notes` }),
    );
    await waitFor(() => expect(backend.deletes).toBe(1));
    expect(await screen.findByRole('button', { name: `Connect ${name}` })).toBeInTheDocument();
  });

  it('Rose Desktop: the row shows the account and disconnects from its chip', async () => {
    const backend = granolaBackend(provider, document, authorizeUrl);
    backend.connected = true;
    renderWithProviders(<Integrations />);
    const user = userEvent.setup();

    const row = await screen.findByTestId(`integration-row-${provider}`);
    await waitFor(() =>
      expect(within(row).getByTestId(`accounts-${provider}`)).toHaveTextContent('andy@example.com'),
    );
    await user.click(within(row).getByRole('button', { name: `Disconnect ${name}` }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(backend.deletes).toBe(1));
    expect(
      await within(screen.getByTestId(`integration-row-${provider}`)).findByRole('button', {
        name: `Connect ${name}`,
      }),
    ).toBeInTheDocument();
  });
});

describe.each(providers)(
  '$name sign-in callback page',
  ({ provider, name, document, Callback }) => {
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
        http.post(`${API_BASE}/integrations/${provider}/oauth/complete`, async ({ request }) => {
          completes.push(await request.json());
          return HttpResponse.json(status(document, true, 0));
        }),
      );
      sessionStorage.setItem(`rose.${provider}.returnPath`, '/integrations?tab=data');
      const replace = at('?code=abc&state=user.nonce');
      renderWithProviders(<Callback />, { roseDesktop: false });

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/integrations?tab=data'));
      expect(completes).toEqual([{ code: 'abc', state: 'user.nonce' }]);
      expect(sessionStorage.getItem(`rose.${provider}.returnPath`)).toBeNull();
    });

    it('shows why a refused sign-in did not connect', async () => {
      server.use(
        http.post(`${API_BASE}/integrations/${provider}/oauth/complete`, () =>
          HttpResponse.json(
            { error: 'STATE_INVALID', message: 'Unknown or already used Granola sign-in' },
            { status: 400 },
          ),
        ),
      );
      const replace = at('?code=abc&state=other.nonce');
      renderWithProviders(<Callback />, { roseDesktop: false });

      expect(
        await screen.findByText('Unknown or already used Granola sign-in'),
      ).toBeInTheDocument();
      expect(replace).not.toHaveBeenCalled();
    });

    it('shows a Granola error without calling the backend', async () => {
      let calls = 0;
      server.use(
        http.post(`${API_BASE}/integrations/${provider}/oauth/complete`, () => {
          calls += 1;
          return HttpResponse.json({});
        }),
      );
      at('?error=access_denied');
      renderWithProviders(<Callback />, { roseDesktop: false });

      expect(await screen.findByText(`${name} sign-in access_denied.`)).toBeInTheDocument();
      expect(calls).toBe(0);
    });
  },
);

describe.each([false, true])('integration search (Rose Desktop=%s)', (roseDesktop) => {
  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());
  it('matches provider names, domains and capability tokens in the unified meeting group', async () => {
    renderWithProviders(<Integrations />, { roseDesktop });
    const user = userEvent.setup();
    const input = screen.getByRole('searchbox', { name: 'Search integrations' });
    await screen.findByRole('button', { name: 'Connect Fireflies' });
    for (const query of [
      'meeting',
      'transcript',
      'FIREFLIES.AI   Transcript',
      '  GrAnOlA  notes  ',
    ]) {
      await user.clear(input);
      await user.type(input, query);
      const group = screen.getByRole('region', { name: 'Meeting note taker' });
      expect(within(group).getByRole('button', { name: 'Connect Granola' })).toBeVisible();
      expect(within(group).getByRole('button', { name: 'Connect Fireflies' })).toBeVisible();
      expect(within(group).getByText('granola.ai, fireflies.ai, etc.')).toBeVisible();
      expect(
        screen.queryByRole('button', { name: 'Connect Pebble Index 01' }),
      ).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: 'Clear integration search' }));
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Connect Pebble Index 01' })).toBeVisible();
  });

  it('requires every token, shows a useful empty state and restores the catalog', async () => {
    renderWithProviders(<Integrations />, { roseDesktop });
    const user = userEvent.setup();
    const input = screen.getByRole('searchbox', { name: 'Search integrations' });
    await screen.findByRole('button', { name: 'Connect Fireflies' });
    await user.type(input, 'fireflies impossible-match');
    expect(screen.getByRole('status')).toHaveTextContent('No integrations found');
    expect(screen.queryByRole('button', { name: 'Connect Fireflies' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.queryByText('No integrations found')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Fireflies' })).toBeVisible();
    await user.type(input, 'email inbox');
    expect(screen.getByText('Messages')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Meeting note taker' })).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '   ');
    expect(screen.getByRole('button', { name: 'Connect Fireflies' })).toBeVisible();
  });
});
