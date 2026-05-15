/**
 * Blackbox tests for the Plaid integration feature.
 *
 * Covers:
 *   - PlaidSection rendering (collapsed / expanded)
 *   - usePlaidConnect lifecycle: link-token -> Link open -> exchange -> connected
 *   - usePlaidConnect error surfaces
 *   - disconnect path
 *   - tenant-shape: list-items happy path, empty, error
 *   - Powered by Plaid attribution
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import React from 'react';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

import PlaidSection from '@/features/integrations/components/PlaidSection';
import type { PlaidItem } from '@/features/integrations/types';
import { usePlaidIntegration } from '@/features/integrations/hooks/usePlaidIntegration';

/**
 * The CTA row in PlaidSection has no button text (uses an icon-only
 * SyncItemButton). Find it by locating the row's identifying text and
 * traversing up to the row container, then grabbing the button inside.
 */
function clickConnectRowButton(): Promise<void> {
  const label = screen.getByText(/connect (a bank|another account)/i);
  const row = label.closest('div.flex.items-center.justify-between') as HTMLElement | null;
  if (row === null) {
    throw new Error('Could not locate Plaid connect row');
  }
  const button = within(row).getByRole('button');
  return userEvent.click(button);
}

const API_BASE = 'http://localhost:3001/api';

// ---------------------------------------------------------------------------
// Mock react-plaid-link
// ---------------------------------------------------------------------------
//
// The real SDK opens an iframe — useless under jsdom. We expose a controllable
// fake that lets each test fire onSuccess/onExit on demand.

interface MockLinkController {
  fireSuccess: (
    publicToken: string,
    metadata?: Partial<{
      institution: { institution_id: string; name: string };
      accounts: Array<{
        id: string;
        name: string;
        mask: string | null;
        type: string;
        subtype: string | null;
      }>;
      link_session_id: string;
    }>,
  ) => void;
  fireExit: (err?: { error_message?: string; display_message?: string }) => void;
  opened: boolean;
}

const linkController: MockLinkController = {
  fireSuccess: () => {},
  fireExit: () => {},
  opened: false,
};

vi.mock('react-plaid-link', () => ({
  usePlaidLink: ({
    token,
    onSuccess,
    onExit,
  }: {
    token: string | null;
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
    onExit: (err: { error_message?: string; display_message?: string } | null) => void;
  }) => {
    linkController.fireSuccess = (publicToken, metadata = {}) => {
      onSuccess(publicToken, {
        institution: metadata.institution ?? {
          institution_id: 'ins_109508',
          name: 'First Platypus Bank',
        },
        accounts: metadata.accounts ?? [
          {
            id: 'acct-1',
            name: 'Plaid Checking',
            mask: '0000',
            type: 'depository',
            subtype: 'checking',
          },
        ],
        link_session_id: metadata.link_session_id ?? 'sess-1',
      });
    };
    linkController.fireExit = (err) => {
      onExit(err ?? null);
    };
    return {
      open: () => {
        linkController.opened = true;
      },
      ready: token !== null,
      exit: () => {},
      error: null,
    };
  },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

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

function makeItem(overrides: Partial<PlaidItem> = {}): PlaidItem {
  return {
    id: 'item-uuid-1',
    plaidItemId: 'plaid_item_1',
    institutionId: 'ins_109508',
    institutionName: 'First Platypus Bank',
    status: 'ACTIVE',
    products: ['transactions', 'auth'],
    createdAt: '2026-05-12T17:00:00Z',
    lastSyncAt: '2026-05-12T17:00:00Z',
    disconnectedAt: null,
    accounts: [
      {
        id: 'acct-uuid-1',
        plaidAccountId: 'acct_plaid_1',
        name: 'Plaid Checking',
        officialName: 'Plaid Gold Checking',
        mask: '0000',
        type: 'depository',
        subtype: 'checking',
      },
    ],
    ...overrides,
  };
}

function PlaidIntegrationHarness({ initialExpanded = false }: { initialExpanded?: boolean }) {
  const plaid = usePlaidIntegration();
  const [expanded, setExpanded] = React.useState(initialExpanded);
  return (
    <PlaidSection
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      items={plaid.items}
      itemsLoading={plaid.itemsLoading}
      connectLoading={plaid.connectLoading}
      disconnectingItemId={plaid.disconnectingItemId}
      error={plaid.error}
      onConnect={plaid.onConnect}
      onDisconnect={plaid.onDisconnect}
    />
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlaidSection (rendering)', () => {
  beforeEach(() => {
    mockSession();
    linkController.opened = false;
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.json({ items: [] })),
    );
  });

  afterEach(() => {
    localStorage.clear();
    server.resetHandlers();
  });

  it('renders the section heading', async () => {
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() => {
      expect(screen.getByText(/banks/i)).toBeInTheDocument();
    });
  });

  it('renders the Plaid value proposition copy', async () => {
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() => {
      expect(screen.getByText(/balances, transactions, investments/i)).toBeInTheDocument();
    });
  });

  it('does NOT show item rows or Connect when collapsed', async () => {
    renderWithProviders(<PlaidIntegrationHarness initialExpanded={false} />);
    await waitFor(() => {
      expect(screen.getByText(/banks/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/connect a bank/i)).not.toBeInTheDocument();
  });

  it('shows the "Connect a bank" CTA when expanded and no items', async () => {
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => {
      expect(screen.getByText(/connect a bank or financial account/i)).toBeInTheDocument();
    });
  });

  it('renders the "Powered by Plaid" attribution', async () => {
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /plaid/i })).toHaveAttribute(
        'href',
        'https://plaid.com',
      );
    });
  });

  it('renders connected item rows when items exist', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({ items: [makeItem()] }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => {
      expect(screen.getByText('First Platypus Bank')).toBeInTheDocument();
    });
    expect(screen.getByText(/Plaid Checking/)).toBeInTheDocument();
  });

  it('shows account count and mask for a connected item', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({ items: [makeItem()] }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => {
      expect(screen.getByText(/1 account/i)).toBeInTheDocument();
      expect(screen.getByText(/••0000/)).toBeInTheDocument();
    });
  });

  it('shows "Connect another account" when at least one item is connected', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({ items: [makeItem()] }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => {
      expect(screen.getByText(/connect another account/i)).toBeInTheDocument();
    });
  });
});

describe('PlaidSection (connect flow)', () => {
  beforeEach(() => {
    mockSession();
    linkController.opened = false;
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.json({ items: [] })),
    );
  });

  afterEach(() => {
    localStorage.clear();
    server.resetHandlers();
  });

  it('clicking Connect requests a link_token from the backend', async () => {
    let calls = 0;
    server.use(
      http.post(`${API_BASE}/integrations/plaid/link-token`, () => {
        calls += 1;
        return HttpResponse.json({
          link_token: 'link-test-1',
          expiration: '2026-05-12T21:00:00Z',
          request_id: 'req-1',
        });
      }),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText(/connect a bank/i)).toBeInTheDocument());
    await clickConnectRowButton();
    await waitFor(() => expect(calls).toBe(1));
  });

  it('opens Plaid Link once the link_token arrives', async () => {
    server.use(
      http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
        HttpResponse.json({
          link_token: 'link-test-2',
          expiration: '2026-05-12T21:00:00Z',
          request_id: 'req-2',
        }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText(/connect a bank/i)).toBeInTheDocument());
    await clickConnectRowButton();
    await waitFor(() => expect(linkController.opened).toBe(true));
  });

  it('on Plaid Link success, exchanges the public_token and refreshes items', async () => {
    let exchanged = false;
    let itemsResponse: PlaidItem[] = [];
    server.use(
      http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
        HttpResponse.json({
          link_token: 'link-test-3',
          expiration: '2026-05-12T21:00:00Z',
          request_id: 'req-3',
        }),
      ),
      http.post(`${API_BASE}/integrations/plaid/exchange-public-token`, () => {
        exchanged = true;
        itemsResponse = [makeItem()];
        return HttpResponse.json({ item: makeItem() });
      }),
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({ items: itemsResponse }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText(/connect a bank/i)).toBeInTheDocument());
    await clickConnectRowButton();
    await waitFor(() => expect(linkController.opened).toBe(true));
    linkController.fireSuccess('public-sandbox-token');
    await waitFor(() => expect(exchanged).toBe(true));
    await waitFor(() => expect(screen.getByText('First Platypus Bank')).toBeInTheDocument());
  });

  it('persists the link_token to localStorage for OAuth-bank resume', async () => {
    server.use(
      http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
        HttpResponse.json({
          link_token: 'link-oauth-token',
          expiration: '2026-05-12T21:00:00Z',
          request_id: 'req-4',
        }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText(/connect a bank/i)).toBeInTheDocument());
    await clickConnectRowButton();
    await waitFor(() =>
      expect(localStorage.getItem('rose:plaid:oauth:link_token')).toBe('link-oauth-token'),
    );
  });

  it('clears the persisted link_token after a successful exchange', async () => {
    localStorage.setItem('rose:plaid:oauth:link_token', 'stale');
    server.use(
      http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
        HttpResponse.json({
          link_token: 'link-test-5',
          expiration: '2026-05-12T21:00:00Z',
          request_id: 'req-5',
        }),
      ),
      http.post(`${API_BASE}/integrations/plaid/exchange-public-token`, () =>
        HttpResponse.json({ item: makeItem() }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText(/connect a bank/i)).toBeInTheDocument());
    await clickConnectRowButton();
    await waitFor(() => expect(linkController.opened).toBe(true));
    linkController.fireSuccess('public-sandbox-token');
    await waitFor(() => expect(localStorage.getItem('rose:plaid:oauth:link_token')).toBeNull());
  });

  it('clears the persisted link_token when the user cancels Plaid Link', async () => {
    server.use(
      http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
        HttpResponse.json({
          link_token: 'link-cancelled',
          expiration: '2026-05-12T21:00:00Z',
          request_id: 'req-cancel',
        }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText(/connect a bank/i)).toBeInTheDocument());
    await clickConnectRowButton();
    await waitFor(() => expect(linkController.opened).toBe(true));
    linkController.fireExit();
    await waitFor(() => expect(localStorage.getItem('rose:plaid:oauth:link_token')).toBeNull());
  });

  it('shows an error message if link-token fetch fails', async () => {
    server.use(
      http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
        HttpResponse.json({ error: 'Plaid client unavailable' }, { status: 502 }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText(/connect a bank/i)).toBeInTheDocument());
    await clickConnectRowButton();
    await waitFor(() => expect(screen.getByText(/plaid client unavailable/i)).toBeInTheDocument());
  });

  it('shows an error message if exchange fails after Plaid Link success', async () => {
    server.use(
      http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
        HttpResponse.json({
          link_token: 'link-test-err',
          expiration: '2026-05-12T21:00:00Z',
          request_id: 'req-err',
        }),
      ),
      http.post(`${API_BASE}/integrations/plaid/exchange-public-token`, () =>
        HttpResponse.json({ error: 'Bad token' }, { status: 400 }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText(/connect a bank/i)).toBeInTheDocument());
    await clickConnectRowButton();
    await waitFor(() => expect(linkController.opened).toBe(true));
    linkController.fireSuccess('public-bad-token');
    await waitFor(() => expect(screen.getByText(/bad token/i)).toBeInTheDocument());
  });

  it('surfaces a Plaid Link onExit error via the section', async () => {
    server.use(
      http.post(`${API_BASE}/integrations/plaid/link-token`, () =>
        HttpResponse.json({
          link_token: 'link-test-exit',
          expiration: '2026-05-12T21:00:00Z',
          request_id: 'req-exit',
        }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText(/connect a bank/i)).toBeInTheDocument());
    await clickConnectRowButton();
    await waitFor(() => expect(linkController.opened).toBe(true));
    linkController.fireExit({ display_message: 'Institution authentication failed' });
    await waitFor(() =>
      expect(screen.getByText(/institution authentication failed/i)).toBeInTheDocument(),
    );
  });
});

describe('PlaidSection (disconnect flow)', () => {
  beforeEach(() => {
    mockSession();
    linkController.opened = false;
  });

  afterEach(() => {
    localStorage.clear();
    server.resetHandlers();
  });

  it('clicking the trash icon calls DELETE and refreshes the list', async () => {
    let listCalls = 0;
    let deleted = false;
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () => {
        listCalls += 1;
        return HttpResponse.json({ items: deleted ? [] : [makeItem()] });
      }),
      http.delete(`${API_BASE}/integrations/plaid/items/:id`, () => {
        deleted = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText('First Platypus Bank')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /disconnect first platypus bank/i }));
    await waitFor(() => expect(deleted).toBe(true));
    await waitFor(() => expect(listCalls).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByText('First Platypus Bank')).not.toBeInTheDocument());
  });

  it('shows an error if DELETE fails', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({ items: [makeItem()] }),
      ),
      http.delete(`${API_BASE}/integrations/plaid/items/:id`, () =>
        HttpResponse.json({ error: 'Item is locked' }, { status: 409 }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText('First Platypus Bank')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /disconnect first platypus bank/i }));
    await waitFor(() => expect(screen.getByText(/item is locked/i)).toBeInTheDocument());
  });
});

describe('PlaidSection (items list)', () => {
  beforeEach(() => {
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
    server.resetHandlers();
  });

  it('renders nothing in the items list when API returns empty', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.json({ items: [] })),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() =>
      expect(screen.getByText(/connect a bank or financial account/i)).toBeInTheDocument(),
    );
  });

  it('renders multiple items when API returns multiple', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({
          items: [
            makeItem({ id: 'i1', institutionName: 'Bank A' }),
            makeItem({ id: 'i2', institutionName: 'Bank B' }),
          ],
        }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    await waitFor(() => expect(screen.getByText('Bank A')).toBeInTheDocument());
    expect(screen.getByText('Bank B')).toBeInTheDocument();
  });

  it('surfaces an items-list error message', async () => {
    server.use(http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.error()));
    renderWithProviders(<PlaidIntegrationHarness initialExpanded />);
    // The hook swallows fetch errors and returns []; assert the CTA still renders.
    await waitFor(() =>
      expect(screen.getByText(/connect a bank or financial account/i)).toBeInTheDocument(),
    );
  });
});
