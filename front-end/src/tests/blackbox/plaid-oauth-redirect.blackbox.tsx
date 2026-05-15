/**
 * Blackbox tests for the Plaid OAuth redirect page.
 *
 * Covers:
 *   - missing-token state shows the "Connection session not found" UI
 *   - happy path: localStorage has token -> Link opens -> success fires
 *     exchange -> redirect via window.location.replace
 *   - error path: Plaid Link onExit with display_message surfaces it
 *   - error path: exchange API failure surfaces an error message
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import PlaidOAuthRedirect from '@/features/integrations/components/PlaidOAuthRedirect';

const API_BASE = 'http://localhost:3001/api';

interface MockLinkController {
  fireSuccess: (publicToken: string) => void;
  fireExit: (err?: { display_message?: string; error_message?: string }) => void;
  opened: boolean;
  receivedToken: string | null;
  receivedRedirectUri: string | undefined;
}

const link: MockLinkController = {
  fireSuccess: () => {},
  fireExit: () => {},
  opened: false,
  receivedToken: null,
  receivedRedirectUri: undefined,
};

vi.mock('react-plaid-link', () => ({
  usePlaidLink: (opts: {
    token: string | null;
    receivedRedirectUri?: string;
    onSuccess: (
      publicToken: string,
      metadata: {
        institution: { institution_id: string; name: string } | null;
        accounts: Array<{
          id: string;
          name: string;
          mask: string | null;
          type: string;
          subtype: string | null;
        }>;
        link_session_id: string;
      },
    ) => void;
    onExit: (err: { display_message?: string; error_message?: string } | null) => void;
  }) => {
    link.receivedToken = opts.token;
    link.receivedRedirectUri = opts.receivedRedirectUri;
    link.fireSuccess = (publicToken: string): void => {
      opts.onSuccess(publicToken, {
        institution: { institution_id: 'ins_chase', name: 'Chase' },
        accounts: [
          {
            id: 'acct-x',
            name: 'Plaid Saving',
            mask: '1111',
            type: 'depository',
            subtype: 'savings',
          },
        ],
        link_session_id: 'sess-redirect-1',
      });
    };
    link.fireExit = (err) => opts.onExit(err ?? null);
    return {
      open: () => {
        link.opened = true;
      },
      ready: opts.token !== null,
      exit: () => {},
      error: null,
    };
  },
}));

function mockSession(): void {
  const session = {
    access_token: 'oauth-test-token',
    refresh_token: 'r',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: 'oauth-test-user', is_anonymous: false },
  };
  localStorage.setItem('rose-session', JSON.stringify(session));
  localStorage.setItem('app-user', JSON.stringify({ id: 'oauth-test-user', is_anonymous: false }));
}

describe('PlaidOAuthRedirect', () => {
  beforeEach(() => {
    mockSession();
    link.opened = false;
    link.receivedToken = null;
    link.receivedRedirectUri = undefined;
  });

  afterEach(() => {
    localStorage.clear();
    server.resetHandlers();
  });

  it('shows the missing-session error when localStorage has no link_token', async () => {
    renderWithProviders(<PlaidOAuthRedirect />);
    await waitFor(() =>
      expect(screen.getByText(/connection session not found/i)).toBeInTheDocument(),
    );
  });

  it('passes window.location.href as receivedRedirectUri to Plaid Link', async () => {
    localStorage.setItem('rose:plaid:oauth:link_token', 'link-oauth-existing');
    renderWithProviders(<PlaidOAuthRedirect />);
    await waitFor(() => expect(link.opened).toBe(true));
    expect(link.receivedRedirectUri).toBe(window.location.href);
    expect(link.receivedToken).toBe('link-oauth-existing');
  });

  it('opens Plaid Link with the stored token on mount', async () => {
    localStorage.setItem('rose:plaid:oauth:link_token', 'link-stored');
    renderWithProviders(<PlaidOAuthRedirect />);
    await waitFor(() => expect(link.opened).toBe(true));
    expect(screen.getByText(/resuming your bank connection/i)).toBeInTheDocument();
  });

  it('exchanges the public_token on success and removes the stored token', async () => {
    localStorage.setItem('rose:plaid:oauth:link_token', 'link-stored-2');
    let exchanged = false;
    server.use(
      http.post(`${API_BASE}/integrations/plaid/exchange-public-token`, () => {
        exchanged = true;
        return HttpResponse.json({
          item: {
            id: 'item-1',
            plaidItemId: 'plaid_item',
            institutionId: 'ins_chase',
            institutionName: 'Chase',
            status: 'ACTIVE',
            products: [],
            createdAt: '2026-05-12T17:00:00Z',
            lastSyncAt: null,
            disconnectedAt: null,
            accounts: [],
          },
        });
      }),
    );
    const replaceMock = vi.fn();
    Object.defineProperty(window, 'location', {
      writable: true,
      value: {
        ...window.location,
        replace: replaceMock,
        href: 'http://localhost/plaid-oauth-redirect?oauth_state=xyz',
      },
    });
    renderWithProviders(<PlaidOAuthRedirect successHref="/done" />);
    await waitFor(() => expect(link.opened).toBe(true));
    link.fireSuccess('public-oauth-token');
    await waitFor(() => expect(exchanged).toBe(true));
    await waitFor(() => expect(localStorage.getItem('rose:plaid:oauth:link_token')).toBeNull());
    await waitFor(() => expect(replaceMock).toHaveBeenCalledWith('/done'));
  });

  it('shows an error message if the exchange API returns an error', async () => {
    localStorage.setItem('rose:plaid:oauth:link_token', 'link-stored-3');
    server.use(
      http.post(`${API_BASE}/integrations/plaid/exchange-public-token`, () =>
        HttpResponse.json({ error: 'Plaid auth expired' }, { status: 502 }),
      ),
    );
    renderWithProviders(<PlaidOAuthRedirect />);
    await waitFor(() => expect(link.opened).toBe(true));
    link.fireSuccess('public-oauth-token');
    await waitFor(() => expect(screen.getByText(/plaid auth expired/i)).toBeInTheDocument());
    expect(screen.getByText(/connection failed/i)).toBeInTheDocument();
  });

  it('surfaces a Plaid Link onExit display_message', async () => {
    localStorage.setItem('rose:plaid:oauth:link_token', 'link-stored-4');
    renderWithProviders(<PlaidOAuthRedirect />);
    await waitFor(() => expect(link.opened).toBe(true));
    link.fireExit({ display_message: 'Bank rejected the session' });
    await waitFor(() => expect(screen.getByText(/bank rejected the session/i)).toBeInTheDocument());
  });

  it('shows a generic message if Plaid Link exits without an error object', async () => {
    localStorage.setItem('rose:plaid:oauth:link_token', 'link-stored-5');
    renderWithProviders(<PlaidOAuthRedirect />);
    await waitFor(() => expect(link.opened).toBe(true));
    link.fireExit();
    await waitFor(() =>
      expect(
        screen.getByText(/plaid link was closed before authentication completed/i),
      ).toBeInTheDocument(),
    );
  });
});
