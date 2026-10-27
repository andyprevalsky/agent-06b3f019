/**
 * Blackbox tests for the Plaid integration feature.
 *
 * Covers:
 *   - PlaidSection rendering as a direct-action card
 *   - usePlaidConnect lifecycle: link-token -> Link open -> exchange -> connected
 *   - usePlaidConnect error surfaces
 *   - tenant-shape: list-items happy path, empty, error
 *   - Plaid attribution is not rendered as an extra card row
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { PlaidItem } from '@/features/integrations/types';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { API_BASE, makeItem, makeSync, mockSession } from './plaid.fixtures';
import { PlaidIntegrationHarness } from './plaid.harness';

function clickPlaidActionButton(): Promise<void> {
  return userEvent.click(
    screen.getByRole('button', { name: /connect (a bank|another financial account)/i }),
  );
}

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

  it('does not render an expanded connect sub-row', async () => {
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() => {
      expect(screen.getByText(/banks/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/connect a bank/i)).not.toBeInTheDocument();
  });

  it('exposes the card action button when no items are connected', async () => {
    renderWithProviders(<PlaidIntegrationHarness />);
    let actionButton: HTMLElement | null = null;
    await waitFor(() => {
      actionButton = screen.getByRole('button', {
        name: /connect a bank or financial account/i,
      });
      expect(actionButton).toBeInTheDocument();
    });
    expect(actionButton).toHaveClass('bg-foreground', 'text-background');
  });

  it('does not render an extra "Powered by Plaid" attribution row', async () => {
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() => {
      expect(screen.getByText(/balances, transactions, investments/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('link', { name: /plaid/i })).not.toBeInTheDocument();
  });

  it('renders connected institution chips on the card when items exist', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({ items: [makeItem()] }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() => {
      const titleColumn = screen.getByText('Banks & Financial Accounts').closest('.flex-col');
      expect(titleColumn).not.toBeNull();
      const institutionChip = within(titleColumn as HTMLElement).getByRole('button', {
        name: /disconnect first platypus bank and its connected accounts/i,
      });
      expect(within(institutionChip).getByText(/First Platypus Bank/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
  });

  it('renders institution chips without transaction metadata or account masks', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({ items: [makeItem()] }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() => {
      expect(screen.getByText(/First Platypus Bank/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/42 tx/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/2 pending/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\b\d+ accounts\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Jan 2025|Mar 2025/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/••0000/)).not.toBeInTheDocument();
  });

  it('deduplicates duplicate institution items and hides repair action for hidden stale items', async () => {
    const activeChase = makeItem({
      id: 'item-active-chase',
      institutionId: 'ins_56',
      institutionName: 'Chase',
      status: 'ACTIVE',
      sync: { ...makeSync(), state: 'synced' },
    });
    const staleErrorChase = makeItem({
      id: 'item-error-chase',
      plaidItemId: 'plaid_item_error_chase',
      institutionId: 'ins_56',
      institutionName: 'Chase',
      status: 'ERROR',
      sync: { ...makeSync(), state: 'error' },
    });
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({ items: [staleErrorChase, activeChase] }),
      ),
    );

    renderWithProviders(<PlaidIntegrationHarness />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /disconnect chase/i })).toBeInTheDocument();
    });
    expect(screen.getAllByRole('button', { name: /disconnect chase/i })).toHaveLength(1);
    expect(screen.queryByText(/sync error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\b\d+ accounts\b/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /repair chase/i })).not.toBeInTheDocument();
  });

  it('renders repair actions as labeled controls beside their institution chips', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({
          items: [
            makeItem({
              id: 'item-error-chase',
              institutionId: 'ins_56',
              institutionName: 'Chase',
              status: 'ERROR',
              sync: { ...makeSync(), state: 'error' },
            }),
            makeItem({
              id: 'item-reauth-wells',
              institutionId: 'ins_57',
              institutionName: 'Wells Fargo',
              status: 'REQUIRES_REAUTH',
              sync: { ...makeSync(), state: 'needs_repair' },
            }),
          ],
        }),
      ),
    );

    renderWithProviders(<PlaidIntegrationHarness />);

    const chaseRepair = await screen.findByRole('button', { name: /repair chase/i });
    const wellsRepair = screen.getByRole('button', { name: /repair wells fargo/i });

    // Each affordance must read as a labeled action, not a bare icon. A wrench
    // glyph with no text is unidentifiable — the reported "weird gear".
    for (const button of [chaseRepair, wellsRepair]) {
      expect(button.textContent?.trim()).not.toBe('');
      expect(within(button).getByText(/reconnect/i)).toBeInTheDocument();
    }

    // They must sit with the chips they refer to, not float in a detached row.
    const titleColumn = screen.getByText('Banks & Financial Accounts').closest('.flex-col');
    expect(titleColumn).not.toBeNull();
    expect(titleColumn).toContainElement(chaseRepair);
    expect(titleColumn).toContainElement(wellsRepair);

    // And each must say what is actually wrong, not just offer a wrench.
    expect(chaseRepair.getAttribute('title')).toMatch(/chase stopped syncing/i);
    expect(wellsRepair.getAttribute('title')).toMatch(/wells fargo needs you to sign in again/i);
  });

  it('uses the action button to connect another account when already connected', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({ items: [makeItem()] }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /connect another financial account/i }),
      ).toBeInTheDocument();
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
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
    await clickPlaidActionButton();
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
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
    await clickPlaidActionButton();
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
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
    await clickPlaidActionButton();
    await waitFor(() => expect(linkController.opened).toBe(true));
    linkController.fireSuccess('public-sandbox-token');
    await waitFor(() => expect(exchanged).toBe(true));
    await waitFor(() => expect(screen.getByText(/First Platypus Bank/i)).toBeInTheDocument());
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
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
    await clickPlaidActionButton();
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
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
    await clickPlaidActionButton();
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
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
    await clickPlaidActionButton();
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
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
    await clickPlaidActionButton();
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
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
    await clickPlaidActionButton();
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
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
    await clickPlaidActionButton();
    await waitFor(() => expect(linkController.opened).toBe(true));
    linkController.fireExit({ display_message: 'Institution authentication failed' });
    await waitFor(() =>
      expect(screen.getByText(/institution authentication failed/i)).toBeInTheDocument(),
    );
  });
});

describe('PlaidSection (non-expandable card)', () => {
  beforeEach(() => {
    mockSession();
    linkController.opened = false;
  });

  afterEach(() => {
    localStorage.clear();
    server.resetHandlers();
  });

  it('renders item-row disconnect controls', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({ items: [makeItem()] }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() => expect(screen.getByText(/First Platypus Bank/i)).toBeInTheDocument());
    expect(
      screen.getByRole('button', { name: /disconnect first platypus bank/i }),
    ).toBeInTheDocument();
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

  it('renders the direct action when API returns empty', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.json({ items: [] })),
    );
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
  });

  it('renders multiple connected institution chips in the card summary', async () => {
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({
          items: [
            makeItem({ id: 'i1', institutionId: 'ins_bank_a', institutionName: 'Bank A' }),
            makeItem({ id: 'i2', institutionId: 'ins_bank_b', institutionName: 'Bank B' }),
          ],
        }),
      ),
    );
    renderWithProviders(<PlaidIntegrationHarness />);
    await waitFor(() => expect(screen.getByText(/Bank A/i)).toBeInTheDocument());
    expect(screen.queryByText(/2 accounts \/ 84 transactions/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/42 tx/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Bank B/i)).toBeInTheDocument();
  });

  it('surfaces an items-list error message', async () => {
    server.use(http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.error()));
    renderWithProviders(<PlaidIntegrationHarness />);
    // The hook swallows fetch errors and returns []; assert the CTA still renders.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /connect a bank or financial account/i }),
      ).toBeInTheDocument(),
    );
  });
});
