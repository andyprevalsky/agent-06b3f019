/**
 * Rose Desktop integrations on the single-account progress contract (lane
 * L-CULL-INTEG):
 *
 *   GET /api/integrations → {integrations: (Row & {accounts: [one entry]})[], accountsByProvider}
 *   GET /api/integrations/progress?since=<cursor> → {cursor, changed?, accountsByProvider?}
 *       the cheap poll, only while something syncs; the cursor is passed back;
 *       a body without `changed` counts as a change when it carries accounts
 *   DELETE /api/integrations/:name → 200 | 404; any other failure is an alert
 *   state syncing|synced|idle|needs_reconnect|sync_failed|EXPIRED;
 *   progress {pct, done, total, unit, eta_sec, phase} | null
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import {
  account,
  API_BASE,
  progress,
  renderIntegrations,
  row,
  rowEl,
  serveList,
} from './integrations-accounts.fixtures';
import { server } from './msw/server';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

function chromeList(entry: Record<string, unknown>) {
  const accounts = [account('chrome', 'default', { label: 'Default profile', ...entry })];
  return { integrations: [row('chrome', accounts)], accountsByProvider: { chrome: accounts } };
}

const chromeEntry = (entry: Record<string, unknown>) => chromeList(entry).accountsByProvider.chrome;

async function renderDesktop() {
  renderIntegrations();
  return screen.findByTestId('rose-desktop-integrations');
}

const chip = (key: string) => rowEl(key).querySelector('[data-tone]');

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('L-CULL-INTEG: Rose Desktop integrations on the single-account contract', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('polls /integrations/progress?since=<cursor> (not the full list) while syncing, then stops', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const syncing = { state: 'syncing', progress: progress({ pct: 40, done: 40, total: 100 }) };
    const served = serveList(
      () => chromeList(syncing),
      (since) => {
        if (since === null) {
          return {
            cursor: 'c1',
            changed: true,
            accountsByProvider: {
              chrome: chromeEntry({ ...syncing, progress: progress({ done: 70, total: 100 }) }),
            },
          };
        }
        if (since === 'c1') {
          return {
            cursor: 'c2',
            changed: true,
            accountsByProvider: { chrome: chromeEntry({ state: 'synced', progress: null }) },
          };
        }
        return { cursor: 'c3', changed: false };
      },
    );
    await renderDesktop();
    const bar = await waitFor(() => within(rowEl('browser-chrome')).getByTestId('sync-progress'));
    expect(within(bar).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');

    await advance(5_000);
    await waitFor(() =>
      expect(within(rowEl('browser-chrome')).getByRole('progressbar')).toHaveAttribute(
        'aria-valuenow',
        '70',
      ),
    );
    await advance(5_000);
    await waitFor(() =>
      expect(within(rowEl('browser-chrome')).queryByTestId('sync-progress')).toBeNull(),
    );
    expect(chip('browser-chrome')).toHaveAttribute('data-tone', 'synced');
    expect(served.progressCalls).toEqual(['', 'c1']);
    expect(served.listCalls).toBe(1);

    // Nothing syncs any more: the poll stops.
    await advance(15_000);
    expect(served.progressCalls).toEqual(['', 'c1']);
  });

  it('a poll body without `changed` still applies its accounts (contract {cursor, accountsByProvider})', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    serveList(
      () => chromeList({ state: 'syncing', progress: progress({ done: 10, total: 100 }) }),
      () => ({
        cursor: 'c1',
        accountsByProvider: { chrome: chromeEntry({ state: 'synced', progress: null }) },
      }),
    );
    await renderDesktop();
    await waitFor(() => expect(chip('browser-chrome')).toHaveAttribute('data-tone', 'syncing'));
    await advance(5_000);
    await waitFor(() => expect(chip('browser-chrome')).toHaveAttribute('data-tone', 'synced'));
  });

  it('needs_reconnect outranks a progress report: no bar', async () => {
    serveList(() =>
      chromeList({
        state: 'needs_reconnect',
        lastError: 'Chrome was signed out',
        progress: progress({ pct: 50, done: 5, total: 10 }),
      }),
    );
    await renderDesktop();
    await waitFor(() => expect(chip('browser-chrome')).toHaveAttribute('data-tone', 'warning'));
    expect(chip('browser-chrome')).toHaveAttribute('title', 'Chrome was signed out');
    expect(within(rowEl('browser-chrome')).queryByTestId('sync-progress')).toBeNull();
  });

  it('shows progress.phase in the bar when present', async () => {
    serveList(() =>
      chromeList({
        state: 'syncing',
        progress: progress({ done: 120, unit: 'cookies', phase: 'Decrypting cookies' }),
      }),
    );
    await renderDesktop();
    const bar = await waitFor(() => within(rowEl('browser-chrome')).getByTestId('sync-progress'));
    expect(bar).toHaveTextContent('Decrypting cookies · 120 cookies');
  });

  it('reads accountsByProvider for a provider that has only reported progress', async () => {
    const imessage = account('imessage', 'default', {
      state: 'syncing',
      progress: progress({ done: 300, total: 1200, unit: 'messages' }),
    });
    serveList(() => ({ integrations: [], accountsByProvider: { imessage: [imessage] } }));
    await renderDesktop();
    const imessageRow = await waitFor(() => rowEl('imessage'));
    await waitFor(() =>
      expect(within(imessageRow).getByTestId('sync-progress')).toBeInTheDocument(),
    );
    expect(within(imessageRow).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
    // The 'default' account id is never shown as a label.
    expect(within(imessageRow).queryByText(/default/)).not.toBeInTheDocument();
    expect(chip('imessage')).toHaveTextContent('This Mac');
  });

  it('a failed disconnect keeps the chip and says why', async () => {
    serveList(() => chromeList({ state: 'synced' }));
    server.use(
      http.delete(`${API_BASE}/integrations/:name`, () =>
        HttpResponse.json({ error: 'Integration is locked' }, { status: 500 }),
      ),
    );
    const user = userEvent.setup();
    await renderDesktop();
    await user.click(await screen.findByRole('button', { name: 'Disconnect Chrome' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Integration is locked');
    expect(chip('browser-chrome')).toBeInTheDocument();
  });
});
