/**
 * Rose Desktop integrations (flag on): flat sections in the stock order, every
 * connected account is a chip with × removal and "+ Add account", no Manage
 * state, and each syncing account shows a progress bar driven by the single
 * useSyncProgress adapter over GET /api/integrations `accounts[].progress`.
 *
 * Contract (lane L-INTEG-CORE): integrations[].accounts[] =
 *   { accountId, label, state, progress: { pct, done, total, unit, eta_sec }, lastSyncAt }
 * total null → indeterminate bar (no pct); eta_sec null → no ETA text;
 * delete is per account. Without `accounts`, today's row status still renders.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import Integrations from '@/pages/Integrations';
import {
  accountToneForState,
  parseIntegrationAccounts,
  parseSyncProgress,
} from '@/features/integrations/hooks/integrationAccounts';
import { formatEta } from '@/features/integrations/components/syncProgressFormat';
import type { ConnectedIntegration } from '@/features/integrations/types';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

const API_BASE = 'http://localhost:3001/api';

function row(name: string, extra: Partial<ConnectedIntegration> = {}): ConnectedIntegration {
  return { id: `int-${name}`, name, status: 'CONNECTED', isActive: true, ...extra };
}

const chromeProfiles = (work: Record<string, unknown> | null) =>
  row('chrome', {
    accounts: [
      { accountId: 'default', label: 'Default profile', state: 'synced', lastSyncAt: null },
      {
        accountId: 'work',
        label: 'Work',
        state: 'syncing',
        progress: work,
        lastSyncAt: null,
      },
    ],
  });

function serve(integrations: unknown[] | (() => unknown[]), plaidItems: unknown[] = []) {
  server.use(
    http.get(`${API_BASE}/integrations`, () =>
      HttpResponse.json({
        integrations: typeof integrations === 'function' ? integrations() : integrations,
      }),
    ),
    http.get(`${API_BASE}/integrations/plaid/items`, () =>
      HttpResponse.json({ items: plaidItems }),
    ),
    http.get(`${API_BASE}/compute-accounts`, () => HttpResponse.json({ accounts: [] })),
  );
}

async function renderDesktop() {
  renderWithProviders(<Integrations />);
  return screen.findByTestId('rose-desktop-integrations');
}

const rowEl = (key: string) => screen.getByTestId(`integration-row-${key}`);

describe('Rose Desktop integrations', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('keeps the stock section order with no Manage state or connected summary', async () => {
    serve([]);
    const list = await renderDesktop();
    await waitFor(() => expect(within(list).getByText('Compute')).toBeInTheDocument());
    const headers = within(list)
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headers).toEqual([
      'Browser Cookies',
      'Passwords',
      'Messages',
      'Compute',
      'Banks & Financial Accounts',
      'Socials',
      'File System',
    ]);
    expect(within(list).queryByText(/manage/i)).not.toBeInTheDocument();
    expect(within(list).queryByText(/\bof \d+ connected/i)).not.toBeInTheDocument();
    // Stock accordion cards are gone with the flag on.
    expect(screen.queryByText('Enable web automation and browsing')).not.toBeInTheDocument();
  });

  it('stock page is unchanged with the flag off', async () => {
    serve([]);
    renderWithProviders(<Integrations />, { roseDesktop: false });
    expect(await screen.findByText('Enable web automation and browsing')).toBeInTheDocument();
    expect(screen.queryByTestId('rose-desktop-integrations')).not.toBeInTheDocument();
  });

  it('renders full progress: N of M unit, ~ETA left, pct on the chip', async () => {
    serve([chromeProfiles({ pct: 41, done: 88, total: 214, unit: 'sites', eta_sec: 60 })]);
    await renderDesktop();
    const chrome = await waitFor(() => rowEl('browser-chrome'));
    const chips = within(chrome).getByTestId('accounts-browser-chrome');
    expect(within(chips).getByText('Default profile').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'synced',
    );
    const work = within(chips).getByText('Work').closest('[data-tone]');
    expect(work).toHaveAttribute('data-tone', 'syncing');
    expect(work).toHaveTextContent('41%');
    const bar = within(chrome).getByTestId('sync-progress');
    expect(bar).toHaveAttribute('data-state', 'determinate');
    expect(within(bar).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '41');
    expect(bar).toHaveTextContent('Work · 88 of 214 sites');
    expect(bar).toHaveTextContent('~1 min left');
  });

  it('total null → indeterminate bar, never a fake percentage', async () => {
    serve([chromeProfiles({ pct: 63, done: 120, total: null, unit: 'sites', eta_sec: null })]);
    await renderDesktop();
    const chrome = await waitFor(() => rowEl('browser-chrome'));
    const bar = within(chrome).getByTestId('sync-progress');
    expect(bar).toHaveAttribute('data-state', 'indeterminate');
    expect(within(bar).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(bar).toHaveTextContent('120 sites');
    expect(bar).not.toHaveTextContent('%');
    expect(within(chrome).getByText('Work').closest('[data-tone]')).not.toHaveTextContent('%');
  });

  it('eta_sec null → ETA text hidden', async () => {
    serve([chromeProfiles({ done: 10, total: 40, unit: 'sites', eta_sec: null })]);
    await renderDesktop();
    const bar = await waitFor(() => within(rowEl('browser-chrome')).getByTestId('sync-progress'));
    expect(bar).toHaveTextContent('10 of 40 sites');
    expect(bar).not.toHaveTextContent('left');
  });

  it('flips a syncing account to synced at 100% and drops its bar', async () => {
    serve([chromeProfiles({ pct: 100, done: 214, total: 214, unit: 'sites', eta_sec: 0 })]);
    await renderDesktop();
    const chrome = await waitFor(() => rowEl('browser-chrome'));
    expect(within(chrome).getByText('Work').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'synced',
    );
    expect(within(chrome).queryByTestId('sync-progress')).not.toBeInTheDocument();
  });

  it('animates live: refetches while syncing and flips when the server reaches 100%', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let pct = 40;
    serve(() => [chromeProfiles({ pct, done: pct, total: 100, unit: 'sites', eta_sec: 30 })]);
    await renderDesktop();
    const bar = await waitFor(() => within(rowEl('browser-chrome')).getByTestId('sync-progress'));
    expect(within(bar).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    pct = 100;
    vi.advanceTimersByTime(5_000);
    await waitFor(() =>
      expect(
        within(rowEl('browser-chrome')).queryByTestId('sync-progress'),
      ).not.toBeInTheDocument(),
    );
    expect(
      within(rowEl('browser-chrome')).getByText('Work').closest('[data-tone]'),
    ).toHaveAttribute('data-tone', 'synced');
  });

  it('removes ONE account through the chip × after confirming', async () => {
    let deleted: string | null = null;
    serve([chromeProfiles(null)]);
    server.use(
      http.delete(`${API_BASE}/integrations/:name/accounts/:accountId`, ({ params }) => {
        deleted = `${String(params.name)}/${String(params.accountId)}`;
        return HttpResponse.json({ ok: true });
      }),
    );
    const user = userEvent.setup();
    await renderDesktop();
    await user.click(await screen.findByRole('button', { name: 'Remove Chrome account Work' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Chrome · Work');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(deleted).toBe('chrome/work'));
    expect(
      capturedRequests.some((r) => r.method === 'DELETE' && r.url.endsWith('/integrations/chrome')),
    ).toBe(false);
  });

  it('falls back to row status without `accounts`: chip, indeterminate bar, row delete', async () => {
    let deleted: string | null = null;
    serve([row('whatsapp'), row('linkedin', { status: 'SYNCING' })]);
    server.use(
      http.delete(`${API_BASE}/integrations/:name`, ({ params }) => {
        deleted = String(params.name);
        return HttpResponse.json({ message: 'ok' });
      }),
    );
    const user = userEvent.setup();
    await renderDesktop();
    const linkedin = await waitFor(() => rowEl('linkedin'));
    expect(within(linkedin).getByText('LinkedIn account').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'syncing',
    );
    expect(within(linkedin).getByTestId('sync-progress')).toHaveAttribute(
      'data-state',
      'indeterminate',
    );
    await user.click(
      within(rowEl('whatsapp')).getByRole('button', {
        name: 'Remove WhatsApp account Linked device',
      }),
    );
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(deleted).toBe('whatsapp'));
  });

  it('Gmail keeps its existing per-address flows; + Add account re-runs Google connect', async () => {
    let disconnected: string | null = null;
    let started = false;
    serve([
      row('gmail', {
        emailCredentials: [
          {
            id: 'c1',
            email: 'a@x.com',
            state: 'connected',
            lastErrorReason: null,
            lastFailedSyncAt: null,
          },
          {
            id: 'c2',
            email: 'b@x.com',
            state: 'connected',
            lastErrorReason: null,
            lastFailedSyncAt: null,
          },
        ],
        accounts: [
          {
            accountId: 'b@x.com',
            label: 'b@x.com',
            state: 'syncing',
            progress: { done: 9120, total: 50410, unit: 'emails', eta_sec: 660 },
          },
        ],
      }),
    ]);
    server.use(
      http.delete(`${API_BASE}/integrations/email/gmail/accounts/:email`, ({ params }) => {
        disconnected = String(params.email);
        return HttpResponse.json({ ok: true });
      }),
      http.post(`${API_BASE}/integrations/email/gmail/start`, () => {
        started = true;
        return HttpResponse.json({ authUrl: 'https://accounts.google.com/o/oauth2/auth' });
      }),
    );
    const user = userEvent.setup();
    await renderDesktop();
    const gmail = await waitFor(() => rowEl('gmail'));
    expect(within(gmail).getAllByText(/@x\.com$/)).toHaveLength(2);
    const bar = within(gmail).getByTestId('sync-progress');
    expect(bar).toHaveTextContent('b@x.com · 9,120 of 50,410 emails');
    expect(bar).toHaveTextContent('~11 min left');
    await user.click(within(gmail).getByRole('button', { name: 'Disconnect a@x.com' }));
    await waitFor(() => expect(disconnected).toBe('a@x.com'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(within(gmail).getByRole('button', { name: 'Add Gmail account' }));
    await waitFor(() => expect(started).toBe(true));
  });

  it('Plaid institutions are chips; a syncing item shows the indeterminate bar', async () => {
    serve(
      [],
      [
        {
          id: 'item-1',
          plaidItemId: 'p-1',
          institutionId: 'ins_1',
          institutionName: 'Amex',
          status: 'ACTIVE',
          products: ['transactions'],
          createdAt: '2026-10-01T00:00:00Z',
          lastSyncAt: null,
          disconnectedAt: null,
          sync: {
            state: 'syncing',
            transactionCount: 0,
            postedTransactionCount: 0,
            pendingTransactionCount: 0,
            removedTransactionCount: 0,
            dateRange: { from: null, to: null },
          },
          accounts: [],
        },
      ],
    );
    await renderDesktop();
    const plaid = await waitFor(() => {
      const el = rowEl('plaid');
      expect(within(el).getByText('Amex')).toBeInTheDocument();
      return el;
    });
    expect(within(plaid).getByText('Amex').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'syncing',
    );
    expect(within(plaid).getByTestId('sync-progress')).toHaveAttribute(
      'data-state',
      'indeterminate',
    );
    expect(within(plaid).getByRole('button', { name: 'Add Plaid account' })).toBeInTheDocument();
  });

  it('Messenger and Instagram have no sync: no bar, coming soon', async () => {
    serve([]);
    await renderDesktop();
    for (const key of ['messenger', 'instagram']) {
      const el = await waitFor(() => rowEl(key));
      expect(el).toHaveTextContent('Coming soon');
      expect(within(el).queryByTestId('sync-progress')).not.toBeInTheDocument();
    }
  });

  it('keeps the currentColor ChatGPT glyph dark on its light tile so it shows in dark mode', async () => {
    serve([]);
    await renderDesktop();
    const codex = await waitFor(() => rowEl('codex'));
    const glyph = codex.querySelector('svg');
    expect(glyph?.closest('.text-\\[\\#111111\\]')).not.toBeNull();
  });
});

describe('integrations account parser', () => {
  it('parses full progress, total null, eta null and bad input', () => {
    expect(
      parseSyncProgress({ pct: 41, done: 88, total: 214, unit: 'sites', eta_sec: 60 }),
    ).toEqual({ pct: 41, done: 88, total: 214, unit: 'sites', etaSec: 60 });
    expect(parseSyncProgress({ done: 50, total: 200, unit: 'emails' })).toMatchObject({ pct: 25 });
    expect(parseSyncProgress({ pct: 70, done: 5, total: null, unit: 'chats' })).toEqual({
      pct: null,
      done: 5,
      total: null,
      unit: 'chats',
      etaSec: null,
    });
    expect(parseSyncProgress({ done: 3, total: 9, eta_sec: null })?.etaSec).toBeNull();
    expect(parseSyncProgress({ done: 3, total: 9 })?.unit).toBe('items');
    expect(parseSyncProgress(null)).toBeNull();
  });

  it('maps states to tones and returns null when `accounts` is absent', () => {
    expect(accountToneForState('syncing')).toBe('syncing');
    expect(accountToneForState('needs_reconnect')).toBe('warning');
    expect(accountToneForState('sync_failed')).toBe('error');
    expect(accountToneForState('connected')).toBe('synced');
    expect(parseIntegrationAccounts(row('chrome'))).toBeNull();
    const accounts = parseIntegrationAccounts(
      chromeProfiles({ pct: 100, done: 1, total: 1, unit: 'sites' }),
    );
    expect(accounts?.map((a) => [a.accountId, a.tone])).toEqual([
      ['default', 'synced'],
      ['work', 'synced'],
    ]);
  });

  it('formats ETAs', () => {
    expect(formatEta(30)).toBe('30 s');
    expect(formatEta(60)).toBe('1 min');
    expect(formatEta(660)).toBe('11 min');
    expect(formatEta(3900)).toBe('1 h 5 min');
  });
});
