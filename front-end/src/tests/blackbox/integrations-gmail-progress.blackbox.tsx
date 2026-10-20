/**
 * Gmail per-address sync progress on Rose Desktop (plan row I3), on the real
 * backend contract (back-end/src/services/integrations/gmailFullSync.ts,
 * gmailSync.ts, domains/integrations/service.accountsView.ts):
 *
 *   full sync      phase scanning → saving, unit 'messages',
 *                  total = messagesTotal or null (null → indeterminate, never a %)
 *   incremental    phase 'history' → light "checking for new mail", no bar
 *   waiting turn   state 'idle' (row SYNCING lease, no progress row yet) → quiet
 *                  queued chip, never an error; it keeps the poll alive
 *   sync_failed    credential state → the existing reconnect chip, unchanged
 *   red dot        only needs_reconnect / EXPIRED light the Integrations icon
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';

import { RoseAppIcons } from '@/features/terminal-component-group/components/rose-apps/RoseAppIcons';

import {
  account,
  chipFor,
  progress,
  renderIntegrations,
  row,
  rowEl,
  serveList,
} from './integrations-accounts.fixtures';
import { renderWithProviders } from './test-wrapper';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

function credential(email: string, state = 'connected') {
  return { id: `cred-${email}`, email, state, lastErrorReason: null, lastFailedSyncAt: null };
}

/** The shared Gmail row: SYNCING is the job lease; each address reports its own state. */
function gmailList(accounts: unknown[], credentials = accounts.map((a) => credential(email(a)))) {
  return {
    integrations: [row('gmail', accounts, { status: 'SYNCING', emailCredentials: credentials })],
    accountsByProvider: { gmail: accounts },
  };
}

const email = (a: unknown) => (a as { accountId: string }).accountId;

const gmail = (address: string, extra: Record<string, unknown>) =>
  account('gmail', address, { label: address, ...extra });

const syncing = (phase: string, counts: Record<string, unknown>) => ({
  state: 'syncing',
  progress: progress({ phase, unit: 'messages', ...counts }),
});

describe('Gmail I3: per-address phases on Rose Desktop', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('scanning without a total is indeterminate; saving with messagesTotal is determinate', async () => {
    serveList(() =>
      gmailList([
        gmail('a@x.com', syncing('scanning', { done: 1200, total: null })),
        gmail('b@x.com', syncing('saving', { done: 300, total: 5000 })),
      ]),
    );
    renderIntegrations();
    const bars = await waitFor(() => {
      const found = within(rowEl('gmail')).getAllByTestId('sync-progress');
      expect(found).toHaveLength(2);
      return found;
    });
    const [scan, save] = bars;
    expect(scan).toHaveAttribute('data-state', 'indeterminate');
    expect(scan).toHaveTextContent('a@x.com · Scanning mailbox · 1,200 messages');
    expect(scan).not.toHaveTextContent('%');
    expect(within(scan).getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    expect(save).toHaveAttribute('data-state', 'determinate');
    expect(save).toHaveTextContent('b@x.com · Saving messages · 300 of 5,000 messages');
    expect(within(save).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '6');
    expect(chipFor('gmail', 'a@x.com')).toHaveAttribute('data-tone', 'syncing');
    expect(chipFor('gmail', 'a@x.com')).not.toHaveTextContent('%');
    expect(chipFor('gmail', 'b@x.com')).toHaveTextContent('6%');
  });

  it("an address waiting its turn ('idle') is a quiet queued chip, not an error", async () => {
    serveList(() =>
      gmailList([
        gmail('a@x.com', syncing('saving', { done: 10, total: 100 })),
        gmail('c@x.com', { state: 'idle', progress: progress() }),
      ]),
    );
    renderIntegrations();
    await waitFor(() =>
      expect(chipFor('gmail', 'c@x.com')).toHaveAttribute('data-tone', 'neutral'),
    );
    const queued = chipFor('gmail', 'c@x.com');
    expect(queued).toHaveTextContent('queued');
    expect(queued).toHaveAttribute('title', 'Waiting for its turn to sync');
    expect(queued?.querySelector('.lucide-triangle-alert, .lucide-alert-triangle')).toBeNull();
    expect(within(rowEl('gmail')).queryByRole('button', { name: 'Reconnect c@x.com' })).toBeNull();
    // Only the address actually syncing has a bar.
    expect(within(rowEl('gmail')).getAllByTestId('sync-progress')).toHaveLength(1);
  });

  it("incremental 'history' is a light 'checking for new mail' state with no bar", async () => {
    serveList(() => gmailList([gmail('d@x.com', syncing('history', { done: 0, total: 12 }))]));
    renderIntegrations();
    await waitFor(() =>
      expect(chipFor('gmail', 'd@x.com')).toHaveAttribute('data-tone', 'syncing'),
    );
    expect(chipFor('gmail', 'd@x.com')).toHaveTextContent('checking for new mail');
    expect(chipFor('gmail', 'd@x.com')).not.toHaveTextContent('%');
    expect(within(rowEl('gmail')).queryByTestId('sync-progress')).toBeNull();
  });

  it('a queued address keeps the progress poll alive until it starts and finishes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const queued = gmail('c@x.com', { state: 'idle', progress: progress() });
    const served = serveList(
      () => gmailList([gmail('a@x.com', { state: 'synced' }), queued]),
      (since) => {
        if (since === null) {
          return {
            cursor: 'c1',
            changed: true,
            accountsByProvider: {
              gmail: [
                gmail('a@x.com', { state: 'synced' }),
                gmail('c@x.com', syncing('scanning', { done: 50, total: null })),
              ],
            },
          };
        }
        if (since === 'c1') {
          return {
            cursor: 'c2',
            changed: true,
            accountsByProvider: {
              gmail: [gmail('a@x.com', { state: 'synced' }), gmail('c@x.com', { state: 'synced' })],
            },
          };
        }
        return { cursor: 'c3', changed: false };
      },
    );
    renderIntegrations();
    await waitFor(() => expect(chipFor('gmail', 'c@x.com')).toHaveTextContent('queued'));
    expect(within(rowEl('gmail')).queryByTestId('sync-progress')).toBeNull();

    vi.advanceTimersByTime(5_000);
    const bar = await waitFor(() => within(rowEl('gmail')).getByTestId('sync-progress'));
    expect(bar).toHaveTextContent('Scanning mailbox · 50 messages');

    vi.advanceTimersByTime(5_000);
    await waitFor(() => expect(chipFor('gmail', 'c@x.com')).toHaveAttribute('data-tone', 'synced'));
    expect(within(rowEl('gmail')).queryByTestId('sync-progress')).toBeNull();
    expect(served.progressCalls).toEqual(['', 'c1']);

    // Nothing syncing or queued any more: the poll stops. React clears the
    // interval in a passive effect after the DOM commit the waitFor above saw,
    // so yield one real macrotask (the scheduler runs it first) before moving the clock.
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.advanceTimersByTime(15_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(served.progressCalls).toEqual(['', 'c1']);
  });

  it('sync_failed keeps the existing reconnect path next to a queued address', async () => {
    const failed = gmail('e@x.com', { state: 'failed', lastError: 'Gmail API 500' });
    const waiting = gmail('c@x.com', { state: 'idle', progress: progress() });
    serveList(() =>
      gmailList([failed, waiting], [credential('e@x.com', 'sync_failed'), credential('c@x.com')]),
    );
    renderIntegrations();
    await waitFor(() =>
      expect(chipFor('gmail', 'e@x.com')).toHaveAttribute('data-tone', 'warning'),
    );
    expect(chipFor('gmail', 'e@x.com')).toHaveTextContent('Needs Reconnection');
    expect(
      within(rowEl('gmail')).getByRole('button', { name: 'Reconnect e@x.com' }),
    ).toBeInTheDocument();
    expect(chipFor('gmail', 'c@x.com')).toHaveAttribute('data-tone', 'neutral');
    expect(within(rowEl('gmail')).queryByRole('button', { name: 'Reconnect c@x.com' })).toBeNull();
  });

  it('flag off: the stock Gmail row shows no queued or phase states', async () => {
    serveList(() =>
      gmailList([
        gmail('a@x.com', syncing('scanning', { done: 1200, total: null })),
        gmail('c@x.com', { state: 'idle', progress: progress() }),
      ]),
    );
    renderIntegrations({ roseDesktop: false });
    expect(await screen.findByText('Enable web automation and browsing')).toBeInTheDocument();
    expect(screen.queryByTestId('rose-desktop-integrations')).toBeNull();
    expect(screen.queryByText(/queued/)).toBeNull();
    expect(screen.queryByText(/Scanning mailbox/)).toBeNull();
    expect(screen.queryByTestId('sync-progress')).toBeNull();
  });
});

describe('Gmail I3: the Integrations icon red dot', () => {
  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());

  it('queued, scanning and history addresses do not raise the reconnect dot', async () => {
    const served = serveList(() =>
      gmailList([
        gmail('a@x.com', syncing('scanning', { done: 1, total: null })),
        gmail('c@x.com', { state: 'idle', progress: progress() }),
        gmail('d@x.com', syncing('history', { done: 0, total: 2 })),
      ]),
    );
    renderWithProviders(<RoseAppIcons />);
    await waitFor(() => expect(served.listCalls).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId('rose-app-integrations-alert')).toBeNull();
  });

  it('a needs_reconnect address among syncing ones still raises it', async () => {
    serveList(() =>
      gmailList(
        [
          gmail('a@x.com', syncing('saving', { done: 1, total: 2 })),
          gmail('b@x.com', { state: 'needs_reconnect' }),
        ],
        [credential('a@x.com'), credential('b@x.com', 'needs_reconnect')],
      ),
    );
    renderWithProviders(<RoseAppIcons />);
    expect(await screen.findByTestId('rose-app-integrations-alert')).toBeInTheDocument();
  });
});
