/**
 * Rose Desktop integrations on the REAL L-INTEG-CORE (I0) backend contract
 * (back-end/src/domains/integrations/syncAccountsContract.ts):
 *
 *   GET /api/integrations → {integrations: (Row & {accounts})[], accountsByProvider}
 *   GET /api/integrations/progress?since=<cursor> → {cursor, changed, accountsByProvider?}
 *       the cheap poll, only while something syncs; the cursor is passed back
 *   DELETE /api/integrations/:provider/accounts/:accountId (accountId URL-encoded)
 *       → 200 | 404 | 501 {error:'ACCOUNT_CLEANUP_NOT_IMPLEMENTED', provider, owner, reason}
 *   SyncState idle|syncing|synced|failed|needs_reconnect; needs_reconnect wins;
 *   progress {pct, done, total, unit, eta_sec, phase, startedAt, updatedAt}
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import Integrations from '@/pages/Integrations';
import type { ConnectedIntegration } from '@/features/integrations/types';

import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

const API_BASE = 'http://localhost:3001/api';

function progress(overrides: Record<string, unknown> = {}) {
  return {
    pct: null,
    done: null,
    total: null,
    unit: null,
    eta_sec: null,
    phase: null,
    startedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

/** IntegrationAccount exactly as service.accountsView.buildAccountsView emits it. */
function account(provider: string, accountId: string, extra: Record<string, unknown> = {}) {
  return {
    provider,
    accountId,
    label: null,
    state: 'synced',
    progress: progress({ pct: 100 }),
    lastSyncAt: null,
    lastError: null,
    ...extra,
  };
}

function row(name: string, accounts: unknown[], extra: Partial<ConnectedIntegration> = {}) {
  return { id: `int-${name}`, name, status: 'CONNECTED', isActive: true, accounts, ...extra };
}

interface Served {
  listCalls: number;
  progressCalls: string[];
}

function serve(
  list: () => { integrations: unknown[]; accountsByProvider: Record<string, unknown[]> },
  onProgress?: (since: string | null) => unknown,
): Served {
  const served: Served = { listCalls: 0, progressCalls: [] };
  server.use(
    http.get(`${API_BASE}/integrations/progress`, ({ request }) => {
      const since = new URL(request.url).searchParams.get('since');
      served.progressCalls.push(since ?? '');
      return HttpResponse.json(onProgress?.(since) ?? { cursor: 'c0', changed: false });
    }),
    http.get(`${API_BASE}/integrations`, () => {
      served.listCalls += 1;
      const body = list();
      return HttpResponse.json({ ...body, count: body.integrations.length });
    }),
    http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.json({ items: [] })),
    http.get(`${API_BASE}/compute-accounts`, () => HttpResponse.json({ accounts: [] })),
  );
  return served;
}

async function renderDesktop() {
  renderWithProviders(<Integrations />);
  return screen.findByTestId('rose-desktop-integrations');
}

const rowEl = (key: string) => screen.getByTestId(`integration-row-${key}`);
const chipFor = (key: string, label: string) =>
  within(rowEl(key)).getByText(label).closest('[data-tone]');

function chromeList(work: Record<string, unknown>) {
  const accounts = [
    account('chrome', 'default', { label: 'Default profile' }),
    account('chrome', 'work', { label: 'Work', ...work }),
  ];
  return { integrations: [row('chrome', accounts)], accountsByProvider: { chrome: accounts } };
}

describe('L-INTEG-CORE: Rose Desktop integrations on the real contract', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('polls /integrations/progress?since=<cursor> (not the full list) while syncing, then stops', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const syncing = { state: 'syncing', progress: progress({ pct: 40, done: 40, total: 100 }) };
    const served = serve(
      () => chromeList(syncing),
      (since) => {
        if (since === null) {
          return {
            cursor: 'c1',
            changed: true,
            accountsByProvider: {
              chrome: chromeList({
                ...syncing,
                progress: progress({ pct: 70, done: 70, total: 100 }),
              }).accountsByProvider.chrome,
            },
          };
        }
        if (since === 'c1') {
          return {
            cursor: 'c2',
            changed: true,
            accountsByProvider: chromeList({ state: 'synced' }).accountsByProvider,
          };
        }
        return { cursor: 'c3', changed: false };
      },
    );
    await renderDesktop();
    const bar = await waitFor(() => within(rowEl('browser-chrome')).getByTestId('sync-progress'));
    expect(within(bar).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');

    vi.advanceTimersByTime(5_000);
    await waitFor(() =>
      expect(
        within(within(rowEl('browser-chrome')).getByTestId('sync-progress')).getByRole(
          'progressbar',
        ),
      ).toHaveAttribute('aria-valuenow', '70'),
    );
    vi.advanceTimersByTime(5_000);
    await waitFor(() =>
      expect(within(rowEl('browser-chrome')).queryByTestId('sync-progress')).toBeNull(),
    );
    expect(chipFor('browser-chrome', 'Work')).toHaveAttribute('data-tone', 'synced');
    expect(served.progressCalls).toEqual(['', 'c1']);
    expect(served.listCalls).toBe(1);

    // Nothing syncs any more: the poll stops.
    vi.advanceTimersByTime(15_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(served.progressCalls).toEqual(['', 'c1']);
  });

  it("state 'failed' → error tone with lastError; needs_reconnect wins over progress", async () => {
    const accounts = [
      account('chrome', 'work', {
        label: 'Work',
        state: 'failed',
        lastError: 'Chrome profile is locked by another process',
      }),
      account('chrome', 'home', {
        label: 'Home',
        state: 'needs_reconnect',
        progress: progress({ pct: 50, done: 5, total: 10 }),
      }),
    ];
    serve(() => ({
      integrations: [row('chrome', accounts)],
      accountsByProvider: { chrome: accounts },
    }));
    await renderDesktop();
    await waitFor(() =>
      expect(chipFor('browser-chrome', 'Work')).toHaveAttribute('data-tone', 'error'),
    );
    const work = chipFor('browser-chrome', 'Work');
    expect(work).toHaveTextContent('sync failed');
    expect(work).toHaveAttribute('title', 'Chrome profile is locked by another process');
    expect(chipFor('browser-chrome', 'Home')).toHaveAttribute('data-tone', 'warning');
    expect(within(rowEl('browser-chrome')).queryByTestId('sync-progress')).toBeNull();
  });

  it('shows progress.phase in the bar when present', async () => {
    serve(() =>
      chromeList({
        state: 'syncing',
        progress: progress({ done: 120, unit: 'cookies', phase: 'Decrypting cookies' }),
      }),
    );
    await renderDesktop();
    const bar = await waitFor(() => within(rowEl('browser-chrome')).getByTestId('sync-progress'));
    expect(bar).toHaveTextContent('Decrypting cookies');
    expect(bar).toHaveTextContent('120 cookies');
  });

  it('reads accountsByProvider for a provider that has only reported progress', async () => {
    const imessage = account('imessage', 'default', {
      state: 'syncing',
      progress: progress({ done: 300, total: 1200, pct: 25, unit: 'messages' }),
    });
    serve(() => ({ integrations: [], accountsByProvider: { imessage: [imessage] } }));
    await renderDesktop();
    const imessageRow = await waitFor(() => rowEl('imessage'));
    await waitFor(() =>
      expect(within(imessageRow).getByTestId('sync-progress')).toBeInTheDocument(),
    );
    expect(within(imessageRow).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    // The legacy 'default' account id is never shown as a label.
    expect(within(imessageRow).queryByText('default')).not.toBeInTheDocument();
  });

  it('DELETE 501 keeps the chip and shows the reason inline', async () => {
    serve(() => chromeList({ state: 'synced' }));
    server.use(
      http.delete(`${API_BASE}/integrations/:name/accounts/:accountId`, () =>
        HttpResponse.json(
          {
            error: 'ACCOUNT_CLEANUP_NOT_IMPLEMENTED',
            provider: 'chrome',
            owner: 'L-INTEG-BROWSERS',
            reason: 'Removing one Chrome profile is not supported yet.',
          },
          { status: 501 },
        ),
      ),
    );
    const user = userEvent.setup();
    await renderDesktop();
    await user.click(await screen.findByRole('button', { name: 'Remove Chrome account Work' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    const reason = await within(rowEl('browser-chrome')).findByTestId('account-removal-blocked');
    expect(reason).toHaveTextContent('Removing one Chrome profile is not supported yet.');
    expect(chipFor('browser-chrome', 'Work')).toBeInTheDocument();
    expect(screen.queryByText('ACCOUNT_CLEANUP_NOT_IMPLEMENTED')).not.toBeInTheDocument();
  });

  it('URL-encodes the account id and refetches the full list after its own delete', async () => {
    const email = 'me+work/team@example.com';
    let accounts = [account('imessage', email, { label: email })];
    const served = serve(() => ({
      integrations: [row('imessage', accounts)],
      accountsByProvider: { imessage: accounts },
    }));
    let deletedUrl = '';
    server.use(
      http.delete(`${API_BASE}/integrations/:name/accounts/:accountId`, ({ request }) => {
        deletedUrl = request.url;
        accounts = [];
        return HttpResponse.json({ deleted: { provider: 'imessage', accountId: email } });
      }),
    );
    const user = userEvent.setup();
    await renderDesktop();
    await user.click(
      await screen.findByRole('button', { name: `Remove iMessage account ${email}` }),
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() =>
      expect(within(rowEl('imessage')).queryByText(email)).not.toBeInTheDocument(),
    );
    expect(deletedUrl).toBe(
      `${API_BASE}/integrations/imessage/accounts/${encodeURIComponent(email)}`,
    );
    expect(served.listCalls).toBeGreaterThanOrEqual(2);
  });
});
