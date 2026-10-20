/**
 * WhatsApp phones on Rose Desktop (plan row I2), on the real contract
 * (back-end/src/domains/integrations/service.whatsappAccounts.ts,
 * mac-app/shared/types/ipc.ts `whatsapp`):
 *
 *   accountsByProvider.whatsapp[]  one per E.164 phone (accountId = label = phone);
 *                                  an unclaimed legacy row is 'default'
 *   progress                       total always null; pct = Baileys percent or null
 *                                  → determinate only when pct is a number
 *   phase                          initial_bootstrap|recent|full|push_name|on_demand
 *   + Add account                  shell handler.addAccount (QR) ?? bridge.addAccount
 *   chip ×                         Mac logout(phone) first, then
 *                                  DELETE /api/integrations/whatsapp/accounts/<encoded phone>;
 *                                  the web (no bridge) only DELETEs
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { parseSyncProgress } from '@/features/integrations/hooks/integrationAccounts';
import { phaseLabel } from '@/features/integrations/components/syncProgressFormat';
import type { WhatsAppHandler } from '@/features/integration-handlers-context';

import { server } from './msw/server';
import {
  API_BASE,
  account,
  chipFor,
  desktopHandlers,
  progress,
  renderIntegrations,
  row,
  rowEl,
  serveList,
} from './integrations-accounts.fixtures';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

const PHONE_A = '+15550001111';
const PHONE_B = '+15550002222';

type Extra = Record<string, unknown>;

function whatsappList(phones: Array<[string, Extra]>) {
  const wire = phones.map(([id, extra]) =>
    account('whatsapp', id, { label: id === 'default' ? null : id, ...extra }),
  );
  return {
    integrations: phones.map(([id]) =>
      row('whatsapp', wire, { accountId: id === 'default' ? '' : id }),
    ),
    accountsByProvider: { whatsapp: wire },
  };
}

type BridgeResult = { success: boolean; error?: string };

/** Installs the Mac bridge on window.api; `events` records call order. */
function installBridge(events: string[], logoutResult: BridgeResult = { success: true }) {
  const bridge = {
    addAccount: vi.fn(async (): Promise<BridgeResult> => {
      events.push('bridge.addAccount');
      return { success: true };
    }),
    logout: vi.fn(async (accountId?: string): Promise<BridgeResult> => {
      events.push(`logout:${accountId ?? '*'}`);
      return logoutResult;
    }),
  };
  Object.defineProperty(window, 'api', {
    value: { whatsapp: bridge },
    configurable: true,
    writable: true,
  });
  return bridge;
}

function captureDeletes(events: string[]) {
  server.use(
    http.delete(`${API_BASE}/integrations/whatsapp/accounts/:accountId`, ({ request }) => {
      events.push(`DELETE ${new URL(request.url).pathname.split('/').pop()}`);
      return HttpResponse.json({ deleted: {} });
    }),
  );
}

function whatsAppHandler(extra: Partial<WhatsAppHandler> = {}): WhatsAppHandler {
  return { isAvailable: true, connect: vi.fn(async () => ({ success: true })), ...extra };
}

async function removePhone(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(await screen.findByRole('button', { name: `Remove WhatsApp account ${label}` }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
  );
}

describe('WhatsApp I2: phones on Rose Desktop', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, 'api');
  });

  it('a measured pct is determinate without a total; no pct is indeterminate', async () => {
    serveList(() =>
      whatsappList([
        [PHONE_A, { state: 'syncing', progress: progress({ pct: 42, phase: 'recent' }) }],
        [PHONE_B, { state: 'syncing', progress: progress({ phase: 'initial_bootstrap' }) }],
      ]),
    );
    renderIntegrations({ handlers: desktopHandlers({ whatsApp: whatsAppHandler() }) });
    const bars = await waitFor(() => {
      const found = within(rowEl('whatsapp')).getAllByTestId('sync-progress');
      expect(found).toHaveLength(2);
      return found;
    });
    expect(bars[0]).toHaveAttribute('data-state', 'determinate');
    expect(within(bars[0]).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '42');
    expect(bars[0]).toHaveTextContent(`${PHONE_A} · Syncing recent chats · 42%`);
    expect(chipFor('whatsapp', PHONE_A)).toHaveTextContent('42%');
    expect(bars[1]).toHaveAttribute('data-state', 'indeterminate');
    expect(bars[1]).toHaveTextContent(`${PHONE_B} · Linking device · Syncing…`);
    expect(bars[1]).not.toHaveTextContent('%');
  });

  it('chip × logs the phone out on this Mac first, then DELETEs the encoded phone', async () => {
    const events: string[] = [];
    installBridge(events);
    captureDeletes(events);
    serveList(() =>
      whatsappList([
        [PHONE_A, {}],
        [PHONE_B, {}],
      ]),
    );
    const user = userEvent.setup();
    renderIntegrations({ handlers: desktopHandlers({ whatsApp: whatsAppHandler() }) });
    await removePhone(user, PHONE_A);
    await waitFor(() =>
      expect(events).toEqual([`logout:${PHONE_A}`, `DELETE ${encodeURIComponent(PHONE_A)}`]),
    );
  });

  it('a failed Mac logout keeps the account: no DELETE, the error is shown', async () => {
    const events: string[] = [];
    installBridge(events, { success: false, error: 'WhatsApp socket busy' });
    captureDeletes(events);
    serveList(() => whatsappList([[PHONE_A, {}]]));
    const user = userEvent.setup();
    renderIntegrations({ handlers: desktopHandlers({ whatsApp: whatsAppHandler() }) });
    await removePhone(user, PHONE_A);
    expect(await screen.findByRole('alert')).toHaveTextContent('WhatsApp socket busy');
    expect(events).toEqual([`logout:${PHONE_A}`]);
    expect(chipFor('whatsapp', PHONE_A)).toBeInTheDocument();
  });

  it("the shell's own logout wins over the raw bridge", async () => {
    const events: string[] = [];
    installBridge(events);
    captureDeletes(events);
    serveList(() => whatsappList([[PHONE_A, {}]]));
    const logout = vi.fn(async (accountId: string) => {
      events.push(`handler.logout:${accountId}`);
      return { success: true };
    });
    const user = userEvent.setup();
    renderIntegrations({ handlers: desktopHandlers({ whatsApp: whatsAppHandler({ logout }) }) });
    await removePhone(user, PHONE_A);
    await waitFor(() =>
      expect(events).toEqual([
        `handler.logout:${PHONE_A}`,
        `DELETE ${encodeURIComponent(PHONE_A)}`,
      ]),
    );
  });

  it('web (no Mac bridge) and the legacy default account only DELETE', async () => {
    const events: string[] = [];
    captureDeletes(events);
    serveList(() => whatsappList([[PHONE_A, {}]]));
    const user = userEvent.setup();
    const web = renderIntegrations();
    await removePhone(user, PHONE_A);
    await waitFor(() => expect(events).toEqual([`DELETE ${encodeURIComponent(PHONE_A)}`]));
    web.unmount();

    events.length = 0;
    const bridge = installBridge(events);
    serveList(() => whatsappList([['default', {}]]));
    renderIntegrations({ handlers: desktopHandlers({ whatsApp: whatsAppHandler() }) });
    await removePhone(user, 'Linked device');
    await waitFor(() => expect(events).toEqual(['DELETE default']));
    expect(bridge.logout).not.toHaveBeenCalled();
  });

  it('+ Add account pairs one more phone through the shell, else the bridge', async () => {
    const events: string[] = [];
    installBridge(events);
    const served = serveList(() => whatsappList([[PHONE_A, {}]]));
    const addAccount = vi.fn(async () => {
      events.push('handler.addAccount');
      return { success: true };
    });
    const user = userEvent.setup();
    const shell = renderIntegrations({
      handlers: desktopHandlers({ whatsApp: whatsAppHandler({ addAccount }) }),
    });
    await user.click(await screen.findByRole('button', { name: 'Add WhatsApp account' }));
    await waitFor(() => expect(events).toEqual(['handler.addAccount']));
    await waitFor(() => expect(served.listCalls).toBeGreaterThanOrEqual(2));
    shell.unmount();

    events.length = 0;
    const handler = whatsAppHandler();
    renderIntegrations({ handlers: desktopHandlers({ whatsApp: handler }) });
    await user.click(await screen.findByRole('button', { name: 'Add WhatsApp account' }));
    await waitFor(() => expect(events).toEqual(['bridge.addAccount']));
    expect(handler.connect).not.toHaveBeenCalled();
  });

  it('a failed pairing shows its error', async () => {
    serveList(() => whatsappList([[PHONE_A, {}]]));
    const addAccount = vi.fn(async () => ({
      success: false,
      error: 'WhatsApp pairing was canceled.',
    }));
    const user = userEvent.setup();
    renderIntegrations({
      handlers: desktopHandlers({ whatsApp: whatsAppHandler({ addAccount }) }),
    });
    await user.click(await screen.findByRole('button', { name: 'Add WhatsApp account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('WhatsApp pairing was canceled.');
  });

  it('flag off: the stock WhatsApp row shows no per-phone chips', async () => {
    serveList(() =>
      whatsappList([[PHONE_A, { state: 'syncing', progress: progress({ pct: 42 }) }]]),
    );
    renderIntegrations({
      roseDesktop: false,
      handlers: desktopHandlers({ whatsApp: whatsAppHandler() }),
    });
    expect(await screen.findByText('Enable web automation and browsing')).toBeInTheDocument();
    expect(screen.queryByText(PHONE_A)).toBeNull();
    expect(screen.queryByTestId('sync-progress')).toBeNull();
  });
});

describe('WhatsApp I2: parsing', () => {
  it('keeps a measured pct only for WhatsApp-style progress', () => {
    expect(parseSyncProgress({ pct: 42, total: null }, { measuredPct: true })?.pct).toBe(42);
    expect(parseSyncProgress({ pct: 42, total: null })?.pct).toBeNull();
    expect(parseSyncProgress({ pct: null, total: null }, { measuredPct: true })?.pct).toBeNull();
    expect(parseSyncProgress({ pct: 140 }, { measuredPct: true })?.pct).toBe(100);
    expect(phaseLabel('whatsapp', 'push_name')).toBe('Updating contact names');
    expect(phaseLabel('whatsapp', 'full')).toBe('Syncing full history');
    expect(phaseLabel('whatsapp', 'on_demand')).toBe('Loading older messages');
  });
});
