/**
 * Password and passkey accounts on Rose Desktop (plan rows I7, A6), on the real
 * backend contract (back-end/src/domains/integrations/service.credentialAccounts.ts,
 * service.accountLabels.ts):
 *
 *   `<source>_passwords`, accountId `<source>:<profile>` ('default' = no profile)
 *     → one chip per profile, labelled by the server ("Chrome · Profile 1", "Chrome")
 *   `<source>_passkeys`, a single 'default' account ("Rose agent", "Apple passkeys")
 *   the chip shows the server label verbatim; a missing label shows the bare id
 *   DELETE /api/integrations/:provider/accounts/:accountId (URL-encoded)
 *   cdp_virtual_passkeys: the confirm dialog states Rose holds the only copy
 *   Order: Browser Cookies, then Passwords (Chrome, Apple, Atlas, other browsers)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { credentialAccountLabel } from '@/features/integrations/components/credentialAccountLabels';
import { parseIntegrationAccounts } from '@/features/integrations/hooks/integrationAccounts';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import {
  API_BASE,
  account,
  chipFor,
  renderIntegrations,
  row,
  rowEl,
  serveList,
} from './integrations-accounts.fixtures';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

// Labels exactly as service.accountLabels.ts names them.
const chromeAccounts = [
  account('chrome_passwords', 'chrome:Profile 1', { label: 'Chrome · Profile 1' }),
  account('chrome_passwords', 'default', { label: 'Chrome' }),
];
const atlasAccounts = [account('atlas_passwords', 'atlas:Default', { label: 'Atlas' })];
const braveAccounts = [account('brave_passwords', 'brave:Work', { label: 'Brave · Work' })];
const agentPasskeys = [account('cdp_virtual_passkeys', 'default', { label: 'Rose agent' })];
const applePasskeys = [account('apple_passwords_passkeys', 'default', { label: 'Apple passkeys' })];
const applePasswords = [account('apple_passwords', 'default', { label: 'Apple Passwords' })];

function credentialList() {
  return {
    integrations: [
      row('chrome_passwords', chromeAccounts, { accountId: 'chrome:Profile 1' }),
      row('chrome_passwords', chromeAccounts, { accountId: '' }),
      row('apple_passwords', applePasswords),
      row('atlas_passwords', atlasAccounts, { accountId: 'atlas:Default' }),
      row('brave_passwords', braveAccounts, { accountId: 'brave:Work' }),
      row('cdp_virtual_passkeys', agentPasskeys),
      row('apple_passwords_passkeys', applePasskeys),
    ],
    accountsByProvider: {
      chrome_passwords: chromeAccounts,
      apple_passwords: applePasswords,
      atlas_passwords: atlasAccounts,
      brave_passwords: braveAccounts,
      cdp_virtual_passkeys: agentPasskeys,
      apple_passwords_passkeys: applePasskeys,
    },
  };
}

function captureDeletes(): string[] {
  const deleted: string[] = [];
  server.use(
    http.delete(`${API_BASE}/integrations/:name/accounts/:accountId`, ({ request, params }) => {
      deleted.push(new URL(request.url).pathname.replace('/api/integrations/', ''));
      return HttpResponse.json({ deleted: { provider: params.name, accountId: params.accountId } });
    }),
  );
  return deleted;
}

const passwordsSection = () => screen.getByRole('region', { name: 'Passwords' });

describe('Passwords I7: one chip per credential account', () => {
  beforeEach(() => mockSession());
  afterEach(() => localStorage.clear());

  it('shows each password profile under its server label, one chip per account', async () => {
    serveList(credentialList);
    renderIntegrations();
    await waitFor(() => expect(chipFor('chrome-passwords', 'Chrome · Profile 1')).not.toBeNull());
    const chrome = within(rowEl('chrome-passwords')).getByTestId('accounts-chrome-passwords');
    expect(
      within(chrome)
        .getAllByText(/^Chrome/)
        .map((el) => el.textContent),
    ).toEqual(['Chrome · Profile 1', 'Chrome']);
    // Never prefixed twice, never a client-derived name.
    expect(screen.queryByText('Chrome · Chrome · Profile 1')).toBeNull();
    expect(screen.queryByText('Chrome · Default profile')).toBeNull();
    // Rows sharing a provider carry one list: no duplicate chips.
    expect(within(chrome).getAllByRole('button', { name: /^Remove Chrome/ })).toHaveLength(2);
    expect(chipFor('atlas-passwords', 'Atlas')).toHaveAttribute('data-tone', 'synced');
    expect(chipFor('passwords-brave', 'Brave · Work')).toBeInTheDocument();
    expect(screen.queryByText('chrome:Profile 1')).toBeNull();
  });

  it('a missing server label shows the bare account id, never a derived name', async () => {
    const unlabeled = [
      account('chrome_passwords', 'chrome:Profile 1'),
      account('chrome_passwords', 'default'),
    ];
    serveList(() => ({
      integrations: [row('chrome_passwords', unlabeled, { accountId: 'chrome:Profile 1' })],
      accountsByProvider: { chrome_passwords: unlabeled },
    }));
    renderIntegrations();
    await waitFor(() => expect(chipFor('chrome-passwords', 'chrome:Profile 1')).not.toBeNull());
    expect(chipFor('chrome-passwords', 'default')).toBeInTheDocument();
    expect(screen.queryByText('Chrome · Profile 1')).toBeNull();
    expect(screen.queryByText('Chrome · Default profile')).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove chrome:Profile 1' })).toBeInTheDocument();
  });

  it('passkey stores show their server labels in the Apple row, each listed once', async () => {
    serveList(credentialList);
    renderIntegrations();
    await waitFor(() => expect(chipFor('apple-passwords', 'Rose agent')).not.toBeNull());
    const apple = within(rowEl('apple-passwords')).getByTestId('accounts-apple-passwords');
    expect(
      within(apple)
        .getAllByText(/^(Apple Passwords|Rose agent|Apple passkeys)$/)
        .map((el) => el.textContent),
    ).toEqual(['Apple Passwords', 'Rose agent', 'Apple passkeys']);
  });

  it('keeps Browser Cookies first, then Passwords: Chrome, Apple, Atlas, other browsers', async () => {
    serveList(credentialList);
    renderIntegrations();
    await waitFor(() => expect(chipFor('passwords-brave', 'Brave · Work')).not.toBeNull());
    const headers = within(screen.getByTestId('rose-desktop-integrations'))
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
    expect(headers.slice(0, 2)).toEqual(['Browser Cookies', 'Passwords']);
    const keys = within(passwordsSection())
      .getAllByTestId(/^integration-row-/)
      .map((el) => el.getAttribute('data-testid'));
    expect(keys).toEqual([
      'integration-row-chrome-passwords',
      'integration-row-apple-passwords',
      'integration-row-atlas-passwords',
      'integration-row-passwords-brave',
    ]);
  });

  it('removing a profile confirms with its label, then DELETEs the encoded account id', async () => {
    serveList(credentialList);
    const deleted = captureDeletes();
    const user = userEvent.setup();
    renderIntegrations();
    await user.click(await screen.findByRole('button', { name: 'Remove Chrome · Profile 1' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Chrome · Profile 1 will be disconnected');
    expect(within(dialog).queryByTestId('remove-account-warning')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() =>
      expect(deleted).toEqual([
        `chrome_passwords/accounts/${encodeURIComponent('chrome:Profile 1')}`,
      ]),
    );
  });

  it('agent passkeys: the dialog states it is the only copy; Cancel deletes nothing', async () => {
    serveList(credentialList);
    const deleted = captureDeletes();
    const user = userEvent.setup();
    renderIntegrations();
    await user.click(await screen.findByRole('button', { name: 'Remove Rose agent' }));
    const dialog = await screen.findByRole('dialog');
    const warning = within(dialog).getByTestId('remove-account-warning');
    expect(warning).toHaveTextContent('only copy of the passkeys your agents enrolled');
    expect(warning).toHaveTextContent('permanently');
    expect(dialog).not.toHaveTextContent('You can connect it again later');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(deleted).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Remove Rose agent' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove' }),
    );
    await waitFor(() => expect(deleted).toEqual(['cdp_virtual_passkeys/accounts/default']));
  });

  it('Apple passkeys keep the ordinary confirm (no only-copy warning)', async () => {
    serveList(credentialList);
    captureDeletes();
    const user = userEvent.setup();
    renderIntegrations();
    await user.click(await screen.findByRole('button', { name: 'Remove Apple passkeys' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByTestId('remove-account-warning')).toBeNull();
    expect(dialog).toHaveTextContent('You can connect it again later');
  });

  it('flag off: the stock Passwords section is unchanged', async () => {
    serveList(credentialList);
    renderIntegrations({ roseDesktop: false });
    expect(await screen.findByText('Enable web automation and browsing')).toBeInTheDocument();
    expect(screen.queryByText('Chrome · Profile 1')).toBeNull();
    expect(screen.queryByText('Rose agent')).toBeNull();
    expect(
      capturedRequests.some((r) => r.method === 'DELETE' && r.url.includes('/integrations/')),
    ).toBe(false);
  });
});

describe('credential account labels', () => {
  it('are the server label verbatim; a missing label is the bare account id', () => {
    const parsed = parseIntegrationAccounts({
      id: 'int-chrome',
      name: 'chrome_passwords',
      status: 'CONNECTED',
      isActive: true,
      accounts: [
        account('chrome_passwords', 'chrome:Profile 1', { label: 'Chrome · Profile 1' }),
        account('chrome_passwords', 'chrome:Default', { label: 'Chrome' }),
        account('chrome_passwords', 'chrome:Work', { label: '' }),
        account('chrome_passwords', 'chrome:Spare'),
      ],
    });
    expect(parsed?.map(credentialAccountLabel)).toEqual([
      'Chrome · Profile 1',
      'Chrome',
      'chrome:Work',
      'chrome:Spare',
    ]);
  });
});
