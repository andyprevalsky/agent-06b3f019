/**
 * Rose Desktop integrations (flag on), UI ledger row 85 / lane L-CULL-INTEG:
 * the existing integrations page design with ONE account per integration
 * (a single chip, × disconnects, no "+ Add account") and a gradient sync
 * loader per integration. Gmail addresses, Plaid institutions and compute
 * subscriptions keep listing several accounts, exactly as the stock page did.
 *
 * Contract: integrations[].accounts = [{ accountId, label, state, progress,
 *   lastSyncAt, lastError }] with state syncing | synced | idle |
 *   needs_reconnect | sync_failed | EXPIRED and progress { pct, done, total,
 *   unit, eta_sec, phase } | null. GET /integrations/progress?since=<cursor>
 *   → { cursor, accountsByProvider }, polled every 5 s only while something
 *   syncs. total null → indeterminate shimmer (never a fake %); eta_sec null
 *   → no ETA; the terminal update flips the chip to synced; only
 *   needs_reconnect / EXPIRED raise the red dot; sync_failed prints lastError.
 *
 * Icons are the stock app-icon tiles (DropdownIconFrame + MessageSyncIcons),
 * visible in light and dark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import {
  accountToneForState,
  parseIntegrationAccount,
  parseSyncProgress,
} from '@/features/integrations/hooks/integrationAccounts';
import { formatEta } from '@/features/integrations/components/syncProgressFormat';
import type { ConnectedIntegration } from '@/features/integrations/types';
import { integrationsNeedingReconnect } from '@/lib/api/integrationHealth';

import {
  account,
  advance,
  API_BASE,
  bars,
  chipFor,
  chips,
  desktopHandlers,
  fakeIntervals,
  iconGlow,
  listOf,
  one,
  progress,
  progressCalls,
  renderDesktop,
  renderIntegrations,
  row,
  rowEl,
  serveList,
} from './integrations-accounts.fixtures';
import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

describe('Rose Desktop integrations: one account per integration', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('keeps the stock section order with no Manage state or connected summary', async () => {
    serveList(() => listOf());
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
      'CLIs',
    ]);
    expect(within(list).queryByText(/manage/i)).not.toBeInTheDocument();
    expect(within(list).queryByText(/\bof \d+ connected/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Enable web automation and browsing')).not.toBeInTheDocument();
  });

  it('stock page is unchanged with the flag off: no chips, bars or desktop rows', async () => {
    serveList(() =>
      listOf(one('imessage', { state: 'syncing', progress: progress({ done: 5, total: 10 }) })),
    );
    renderIntegrations({ roseDesktop: false });
    expect(await screen.findByText('Enable web automation and browsing')).toBeInTheDocument();
    expect(screen.queryByTestId('rose-desktop-integrations')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sync-progress')).not.toBeInTheDocument();
  });

  it('determinate: one chip, one rose→violet bar with "N of M unit" and "~ETA left"', async () => {
    serveList(() =>
      listOf(
        one('chrome', {
          state: 'syncing',
          progress: progress({ pct: 41, done: 88, total: 214, unit: 'cookies', eta_sec: 60 }),
        }),
      ),
    );
    await renderDesktop();
    await waitFor(() => expect(chips('browser-chrome')).toHaveLength(1));
    const chip = chips('browser-chrome')[0];
    expect(chip).toHaveAttribute('data-tone', 'syncing');
    expect(chip).toHaveTextContent('Default profile · 41%');
    expect(bars('browser-chrome')).toHaveLength(1);
    const bar = bars('browser-chrome')[0];
    expect(bar).toHaveAttribute('data-state', 'determinate');
    const track = within(bar).getByRole('progressbar');
    expect(track).toHaveAttribute('aria-valuenow', '41');
    expect(track.className).toContain('h-1');
    const fill = track.firstElementChild as HTMLElement;
    expect(fill.style.width).toBe('41%');
    // Rose→violet gradient (#ff5f8f … #9b4dff) with a soft rose glow.
    expect(fill.getAttribute('style')).toMatch(/rgb\(255, 95, 143\).*rgb\(155, 77, 255\)/);
    expect(fill.style.boxShadow).toBe('0 0 8px rgba(255,95,143,.45)');
    expect(fill.querySelector('.animate-shimmer')).not.toBeNull();
    expect(bar).toHaveTextContent('88 of 214 cookies');
    expect(bar).not.toHaveTextContent('Default profile ·');
    expect(bar).toHaveTextContent('~1 min left');
    // A connected single-account row has no Connect and no "+ Add account".
    expect(within(rowEl('browser-chrome')).queryByRole('button', { name: /^Connect/ })).toBeNull();
    expect(within(rowEl('browser-chrome')).queryByText('+ Add account')).toBeNull();
  });

  it('total null → indeterminate shimmer, counts without a percentage; no counts → "Syncing…"', async () => {
    serveList(() =>
      listOf(
        one('imessage', {
          state: 'syncing',
          progress: progress({ pct: 63, done: 1200, total: null, unit: 'messages' }),
        }),
        one('whatsapp', { state: 'syncing', progress: progress({ unit: 'chats' }) }),
      ),
    );
    await renderDesktop();
    const bar = await waitFor(() => bars('imessage')[0]);
    expect(bar).toHaveAttribute('data-state', 'indeterminate');
    const track = within(bar).getByRole('progressbar');
    expect(track).not.toHaveAttribute('aria-valuenow');
    expect(track.querySelector('.animate-shimmer')).not.toBeNull();
    expect(bar).toHaveTextContent('1,200 messages');
    expect(bar).not.toHaveTextContent('%');
    expect(chips('imessage')[0]).not.toHaveTextContent('%');
    expect(bars('whatsapp')[0]).toHaveTextContent('Syncing…');
    expect(bars('whatsapp')[0]).toHaveAttribute('data-state', 'indeterminate');
  });

  it('eta_sec null → no ETA text; bytes read as sizes', async () => {
    serveList(
      () =>
        listOf(
          one('chrome_passwords', {
            state: 'syncing',
            progress: progress({ done: 10, total: 40, unit: 'passwords', eta_sec: null }),
          }),
          one('linkedin', {
            state: 'syncing',
            progress: progress({ done: 1_500_000, total: 12_000_000, unit: 'bytes' }),
          }),
        ),
      undefined,
    );
    await renderDesktop();
    const bar = await waitFor(() => bars('chrome-passwords')[0]);
    expect(bar).toHaveTextContent('10 of 40 passwords');
    expect(bar).not.toHaveTextContent('left');
    expect(bars('linkedin')[0]).toHaveTextContent('1.5 MB of 12 MB');
  });

  it('polls only while syncing, flips to synced at the terminal update, then stops', async () => {
    fakeIntervals();
    const syncing = one('imessage', {
      state: 'syncing',
      progress: progress({ done: 40, total: 100, unit: 'messages', eta_sec: 30 }),
    });
    const terminal = account('imessage', 'default', { state: 'synced', progress: null });
    const served = serveList(
      () => listOf(syncing),
      (since) =>
        since === null
          ? { cursor: 'c1', changed: true, accountsByProvider: { imessage: [terminal] } }
          : { cursor: 'c2', changed: false },
    );
    await renderDesktop();
    const bar = await waitFor(() => bars('imessage')[0]);
    expect(within(bar).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
    expect(served.progressCalls).toEqual([]);

    await advance(5_000);
    await waitFor(() => expect(bars('imessage')).toHaveLength(0));
    expect(chips('imessage')[0]).toHaveAttribute('data-tone', 'synced');
    expect(served.progressCalls).toEqual(['']);
    // Nothing syncs any more: the poll stopped.
    await advance(20_000);
    expect(served.progressCalls).toEqual(['']);
    expect(served.listCalls).toBe(1);
  });

  it('a 100% report flips the chip to synced even before the state does', async () => {
    serveList(() =>
      listOf(
        one('imessage', {
          state: 'syncing',
          progress: progress({ pct: 100, done: 50, total: 50, unit: 'messages' }),
        }),
      ),
    );
    await renderDesktop();
    await waitFor(() => expect(chips('imessage')[0]).toHaveAttribute('data-tone', 'synced'));
    expect(bars('imessage')).toHaveLength(0);
  });

  it('nothing syncing → no progress request at all', async () => {
    fakeIntervals();
    serveList(() => listOf(one('imessage', { state: 'synced' })));
    await renderDesktop();
    await waitFor(() => expect(chips('imessage')).toHaveLength(1));
    await advance(30_000);
    expect(progressCalls()).toHaveLength(0);
  });

  it('needs_reconnect and EXPIRED: amber "needs reconnect" chip, no bar, amber icon glow', async () => {
    serveList(() =>
      listOf(
        one('whatsapp', {
          state: 'needs_reconnect',
          label: '+1 972 977 7432',
          progress: progress({ done: 3, total: 9 }),
        }),
        one('linkedin', { state: 'EXPIRED', label: 'Andy Prevalsky' }),
        one('imessage', { state: 'synced' }),
      ),
    );
    await renderDesktop();
    await waitFor(() => expect(chips('whatsapp')).toHaveLength(1));
    for (const key of ['whatsapp', 'linkedin']) {
      expect(chips(key)[0]).toHaveAttribute('data-tone', 'warning');
      expect(chips(key)[0]).toHaveTextContent('needs reconnect');
      expect(bars(key)).toHaveLength(0);
      expect(iconGlow(key)?.getAttribute('style')).toContain('245, 158, 11');
    }
    expect(iconGlow('imessage')?.getAttribute('style')).toContain('254, 117, 3');
    // Not connected: no glow.
    expect(iconGlow('gmail')).toBeNull();
  });

  it('sync_failed: red chip and its lastError on a line under it, no bar', async () => {
    serveList(() =>
      listOf(
        one('imessage', {
          state: 'sync_failed',
          lastError: 'Full Disk Access was turned off for Rose.',
          progress: progress({ done: 3, total: 9 }),
        }),
        one('whatsapp', { state: 'sync_failed' }),
      ),
    );
    await renderDesktop();
    await waitFor(() => expect(chips('imessage')).toHaveLength(1));
    expect(chips('imessage')[0]).toHaveAttribute('data-tone', 'error');
    expect(chips('imessage')[0]).toHaveTextContent('sync failed');
    expect(within(rowEl('imessage')).getByTestId('account-sync-error')).toHaveTextContent(
      'Full Disk Access was turned off for Rose.',
    );
    expect(bars('imessage')).toHaveLength(0);
    expect(within(rowEl('whatsapp')).getByTestId('account-sync-error')).toHaveTextContent(
      'The last sync failed.',
    );
  });

  it('a row shows ONE chip even when a stale backend lists several accounts', async () => {
    serveList(() =>
      listOf(
        row('whatsapp', [
          account('whatsapp', '+15550001', { label: '+1 555 0001' }),
          account('whatsapp', '+15550002', { label: '+1 555 0002' }),
        ]),
        row('chrome_passwords', [
          account('chrome_passwords', 'chrome:Default', { label: 'Chrome' }),
          account('chrome_passwords', 'chrome:Profile 1', { label: 'Chrome · Profile 1' }),
        ]),
        one('apple_passwords', { label: 'Apple Passwords' }),
        one('cdp_virtual_passkeys', { label: 'Rose agent' }),
      ),
    );
    await renderDesktop();
    await waitFor(() => expect(chips('whatsapp')).toHaveLength(1));
    expect(chips('whatsapp')[0]).toHaveTextContent('+1 555 0001');
    expect(chips('chrome-passwords')).toHaveLength(1);
    expect(chips('apple-passwords')).toHaveLength(1);
    expect(chips('apple-passwords')[0]).toHaveTextContent('Apple Passwords');
    // No per-source passkey rows or extra password rows.
    expect(screen.queryByTestId('integration-row-passwords-cdp_virtual')).toBeNull();
    for (const key of ['whatsapp', 'chrome-passwords', 'apple-passwords', 'imessage', 'linkedin']) {
      expect(within(rowEl(key)).queryByText('+ Add account')).toBeNull();
    }
  });

  it('× disconnects the row after confirming: DELETE /integrations/:name, then a full refetch', async () => {
    let connected = true;
    const deletes: string[] = [];
    const served = serveList(() =>
      connected ? listOf(one('whatsapp', { label: '+1 972 977 7432' })) : listOf(),
    );
    server.use(
      http.delete(`${API_BASE}/integrations/:name`, ({ params }) => {
        deletes.push(String(params.name));
        connected = false;
        return HttpResponse.json({ message: 'Integration deleted successfully' });
      }),
    );
    const user = userEvent.setup();
    await renderDesktop();
    await user.click(await screen.findByRole('button', { name: 'Disconnect WhatsApp' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('WhatsApp · +1 972 977 7432');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(deletes).toEqual(['whatsapp']));
    await waitFor(() => expect(chips('whatsapp')).toHaveLength(0));
    expect(served.listCalls).toBe(2);
    expect(capturedRequests.some((r) => r.url.includes('/accounts/'))).toBe(false);
  });

  it('falls back to the row status without `accounts`: chip + indeterminate bar', async () => {
    serveList(() => ({
      integrations: [
        row('whatsapp', undefined),
        row('linkedin', undefined, { status: 'SYNCING' }),
        row('imessage', undefined, { status: 'SYNC_FAILED' }),
      ],
      accountsByProvider: {},
    }));
    await renderDesktop();
    await waitFor(() => expect(chips('linkedin')).toHaveLength(1));
    expect(chips('linkedin')[0]).toHaveAttribute('data-tone', 'syncing');
    expect(chips('linkedin')[0]).toHaveTextContent('LinkedIn account');
    expect(bars('linkedin')[0]).toHaveAttribute('data-state', 'indeterminate');
    expect(chips('whatsapp')[0]).toHaveAttribute('data-tone', 'synced');
    expect(chips('whatsapp')[0]).toHaveTextContent('Linked device');
    expect(chips('imessage')[0]).toHaveAttribute('data-tone', 'error');
  });

  it('unconnected rows keep their Connect; LinkedIn connect is the stock export flow', async () => {
    const agentBodies: unknown[] = [];
    const syncBodies: unknown[] = [];
    serveList(() => listOf());
    server.use(
      http.post(`${API_BASE}/agents`, async ({ request }) => {
        agentBodies.push(await request.json());
        return HttpResponse.json({ agent_id: 'agent-linkedin-1', status: 'ACTIVE' });
      }),
      http.post(`${API_BASE}/integrations/linkedin/sync`, async ({ request }) => {
        syncBodies.push(await request.json());
        return HttpResponse.json({ status: 'SYNCING', agent_id: 'agent-linkedin-1' });
      }),
    );
    const user = userEvent.setup();
    await renderDesktop();
    expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Chrome' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect LinkedIn' }));
    await waitFor(() => expect(syncBodies).toEqual([{ agent_id: 'agent-linkedin-1' }]));
    expect(agentBodies).toHaveLength(1);
    // The dropped I4 prompt text is gone: the stock export goal only.
    expect(JSON.stringify(agentBodies[0])).not.toMatch(/export_requested|account_id/);
  });

  it('Gmail keeps every address with "+ Add account"; its one entry drives a single address', async () => {
    let started = false;
    const credential = (email: string) => ({
      id: `c-${email}`,
      email,
      state: 'connected',
      lastErrorReason: null,
      lastFailedSyncAt: null,
    });
    serveList(() =>
      listOf(
        one(
          'gmail',
          {
            state: 'syncing',
            progress: progress({ phase: 'saving', done: 9120, total: 50410, unit: 'messages' }),
          },
          { emailCredentials: [credential('andy@roselabs.ai')] },
        ),
      ),
    );
    server.use(
      http.post(`${API_BASE}/integrations/email/gmail/start`, () => {
        started = true;
        return HttpResponse.json({ authUrl: 'https://accounts.google.com/o/oauth2/auth' });
      }),
    );
    const user = userEvent.setup();
    await renderDesktop();
    await waitFor(() => expect(chips('gmail')).toHaveLength(1));
    expect(chips('gmail')[0]).toHaveTextContent('andy@roselabs.ai · 18%');
    const bar = bars('gmail')[0];
    expect(bar).toHaveTextContent('Saving messages · 9,120 of 50,410 messages');
    await user.click(within(rowEl('gmail')).getByRole('button', { name: 'Add Gmail account' }));
    await waitFor(() => expect(started).toBe(true));
  });

  it('Gmail with several addresses and one row entry shows ONE row bar, no per-chip bars', async () => {
    const credential = (email: string) => ({
      id: `c-${email}`,
      email,
      state: 'connected',
      lastErrorReason: null,
      lastFailedSyncAt: null,
    });
    serveList(() =>
      listOf(
        one(
          'gmail',
          {
            state: 'syncing',
            progress: progress({ phase: 'scanning', done: 500, total: null, unit: 'messages' }),
          },
          { emailCredentials: [credential('a@x.com'), credential('b@x.com')] },
        ),
      ),
    );
    await renderDesktop();
    await waitFor(() => expect(chips('gmail')).toHaveLength(2));
    expect(bars('gmail')).toHaveLength(1);
    expect(bars('gmail')[0]).toHaveTextContent('Scanning mailbox · 500 messages');
    expect(bars('gmail')[0]).not.toHaveTextContent('@x.com');
  });

  it('Plaid lists every institution with "+ Add account"; a syncing item shows its bar', async () => {
    serveList(() => listOf());
    server.use(
      http.get(`${API_BASE}/integrations/plaid/items`, () =>
        HttpResponse.json({
          items: [plaidItem('item-1', 'Amex', 'syncing'), plaidItem('item-2', 'Chase', 'synced')],
        }),
      ),
    );
    await renderDesktop();
    await waitFor(() => expect(chips('plaid')).toHaveLength(2));
    expect(chipFor('plaid', 'Amex')).toHaveAttribute('data-tone', 'syncing');
    expect(chipFor('plaid', 'Chase')).toHaveAttribute('data-tone', 'synced');
    expect(bars('plaid')).toHaveLength(1);
    expect(bars('plaid')[0]).toHaveAttribute('data-state', 'indeterminate');
    expect(within(rowEl('plaid')).getByRole('button', { name: 'Add Plaid account' })).toBeVisible();
  });

  it('compute subscriptions keep every account with "+ Add account"', async () => {
    serveList(() => listOf());
    server.use(
      http.get(`${API_BASE}/compute-accounts`, () =>
        HttpResponse.json({
          accounts: [
            computeAccount('claude', 'acct-1', 'andy@roselabs.ai'),
            computeAccount('claude', 'acct-2', 'ops@roselabs.ai'),
          ],
        }),
      ),
    );
    await renderDesktop({
      handlers: desktopHandlers({
        claudeCode: {
          isAvailable: true,
          hasCredentials: async () => false,
          syncCredentials: async () => ({ success: true }),
        },
      }),
    });
    await waitFor(() => expect(chips('claude')).toHaveLength(2));
    expect(
      within(rowEl('claude')).getByRole('button', { name: 'Add Claude Subscription account' }),
    ).toBeInTheDocument();
  });
});

function plaidItem(id: string, institution: string, state: 'syncing' | 'synced') {
  return {
    id,
    plaidItemId: `p-${id}`,
    institutionId: `ins_${id}`,
    institutionName: institution,
    status: 'ACTIVE',
    products: ['transactions'],
    createdAt: '2026-10-01T00:00:00Z',
    lastSyncAt: null,
    disconnectedAt: null,
    sync: {
      state,
      transactionCount: 0,
      postedTransactionCount: 0,
      pendingTransactionCount: 0,
      removedTransactionCount: 0,
      dateRange: { from: null, to: null },
    },
    accounts: [],
  };
}

function computeAccount(provider: string, accountId: string, accountEmail: string) {
  return {
    provider,
    accountId,
    accountEmail,
    state: 'connected',
    lastErrorReason: null,
    connectedAt: '2026-10-01T00:00:00Z',
  };
}
describe('integrations account parser', () => {
  it('parses full progress; total null is never a percentage; eta null; bad input', () => {
    expect(
      parseSyncProgress({ pct: 41, done: 88, total: 214, unit: 'cookies', eta_sec: 60 }),
    ).toEqual({ pct: 41, done: 88, total: 214, unit: 'cookies', etaSec: 60, phase: null });
    expect(parseSyncProgress({ done: 50, total: 200, unit: 'messages' })).toMatchObject({
      pct: 25,
    });
    expect(parseSyncProgress({ pct: 70, done: 5, total: null, unit: 'chats' })).toEqual({
      pct: null,
      done: 5,
      total: null,
      unit: 'chats',
      etaSec: null,
      phase: null,
    });
    expect(parseSyncProgress({ done: 3, total: 9, eta_sec: null })?.etaSec).toBeNull();
    expect(parseSyncProgress({ done: 3, total: 9 })?.unit).toBe('items');
    expect(parseSyncProgress(null)).toBeNull();
  });

  it('maps every contract state to a tone; only needs_reconnect / EXPIRED need reconnecting', () => {
    expect(accountToneForState('syncing')).toBe('syncing');
    expect(accountToneForState('synced')).toBe('synced');
    expect(accountToneForState('idle')).toBe('synced');
    expect(accountToneForState('needs_reconnect')).toBe('warning');
    expect(accountToneForState('EXPIRED')).toBe('warning');
    expect(accountToneForState('sync_failed')).toBe('error');
    const health = (state: string) => ({
      integrations: [{ name: 'imessage', status: 'CONNECTED', accounts: [{ state }] }],
      plaidItems: [],
    });
    expect(integrationsNeedingReconnect(health('needs_reconnect'))).toEqual(['imessage']);
    expect(integrationsNeedingReconnect(health('EXPIRED'))).toEqual(['imessage']);
    expect(integrationsNeedingReconnect(health('sync_failed'))).toEqual([]);
    expect(integrationsNeedingReconnect(health('syncing'))).toEqual([]);
  });

  it("reads a row's one account (its first entry); null without `accounts`", () => {
    const base = { id: 'r', name: 'imessage', status: 'CONNECTED', isActive: true } as const;
    expect(parseIntegrationAccount(base as ConnectedIntegration)).toBeNull();
    const parsed = parseIntegrationAccount({
      ...base,
      accounts: [
        account('imessage', 'default', {
          state: 'syncing',
          progress: progress({ pct: 100, done: 1, total: 1 }),
        }),
        account('imessage', 'other', { state: 'sync_failed' }),
      ],
    } as ConnectedIntegration);
    expect(parsed?.accountId).toBe('default');
    expect(parsed?.tone).toBe('synced');
    expect(parsed?.unlabeled).toBe(true);
  });

  it('formats ETAs', () => {
    expect(formatEta(30)).toBe('30 s');
    expect(formatEta(60)).toBe('1 min');
    expect(formatEta(660)).toBe('11 min');
    expect(formatEta(3900)).toBe('1 h 5 min');
  });
});
