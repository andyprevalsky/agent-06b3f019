/**
 * Pebble Index 01, the last integration (both presentations): Connect opens a
 * guided setup modal that shows exactly what to type into the Index app's
 * webhook screen, fetched from POST /api/index01/credentials.
 *
 * Contract: credentials = { webhook_url, header_name, header_value } for the
 * signed-in user's dedicated "Index 01" Rose API key; a failure (e.g. 403
 * waitlist) is shown with a Try again that re-requests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import {
  API_BASE,
  listOf,
  renderDesktop,
  renderIntegrations,
  rowEl,
  serveList,
} from './integrations-accounts.fixtures';
import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

const CREDENTIALS = {
  webhook_url: 'https://api.roselabs.ai/api/index01/webhook',
  header_name: 'Authorization',
  header_value: 'Bearer 0123456789abcdef0123456789abcdef',
};

const credentialCalls = () =>
  capturedRequests.filter((r) => new URL(r.url).pathname === '/api/index01/credentials');

function serveCredentials(): { calls: number } {
  const served = { calls: 0 };
  server.use(
    http.post(`${API_BASE}/index01/credentials`, () => {
      served.calls += 1;
      return HttpResponse.json(CREDENTIALS);
    }),
  );
  return served;
}

describe('Pebble Index 01 integration', () => {
  beforeEach(() => {
    mockSession();
    serveList(() => listOf());
  });
  afterEach(() => localStorage.clear());

  it('is the last Rose Desktop row, under "Other" after Granola, and Connect opens the setup', async () => {
    serveCredentials();
    const user = userEvent.setup();
    const list = await renderDesktop();
    await waitFor(() => expect(within(list).getByText('Compute')).toBeInTheDocument());
    const rows = [...list.querySelectorAll('[data-testid^="integration-row-"]')];
    expect(rows[rows.length - 1]).toBe(rowEl('pebble-index'));
    expect(rows[rows.length - 2]).toBe(rowEl('fireflies'));
    const other = within(list).getByRole('region', { name: 'Other' });
    expect(within(list).getByRole('region', { name: 'Meeting note taker' })).toContainElement(
      rowEl('granola'),
    );
    expect(within(list).getByRole('region', { name: 'Meeting note taker' })).toContainElement(
      rowEl('fireflies'),
    );
    expect(within(other).getByText('Pebble Index 01')).toBeInTheDocument();
    expect(within(rowEl('pebble-index')).getByText('Pebble Index 01')).toBeInTheDocument();
    expect(rowEl('pebble-index').querySelector('img[src*="pebble-index-icon"]')).not.toBeNull();

    await user.click(within(rowEl('pebble-index')).getByRole('button', { name: /connect/i }));

    const steps = await screen.findByTestId('pebble-setup-steps');
    expect(within(steps).getByTestId('pebble-value-URL')).toHaveTextContent(
      CREDENTIALS.webhook_url,
    );
    expect(within(steps).getByTestId('pebble-value-Name')).toHaveTextContent('Authorization');
    expect(within(steps).getByTestId('pebble-value-Value')).toHaveTextContent(
      CREDENTIALS.header_value,
    );
    expect(within(steps).getByText(/What to send: Both/)).toBeInTheDocument();
    expect(within(steps).getByText(/Leave “Sign requests” off/)).toBeInTheDocument();
    expect(credentialCalls()).toHaveLength(1);
    expect(credentialCalls()[0].headers.authorization).toBe('Bearer test-token');
  });

  it('copies each value to the clipboard', async () => {
    serveCredentials();
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      writable: true,
      configurable: true,
    });
    await renderDesktop();
    await user.click(within(rowEl('pebble-index')).getByRole('button', { name: /connect/i }));
    await screen.findByTestId('pebble-setup-steps');

    await user.click(screen.getByRole('button', { name: 'Copy Value' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CREDENTIALS.header_value));
    await user.click(screen.getByRole('button', { name: 'Copy URL' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CREDENTIALS.webhook_url));
  });

  it('shows the server error and Try again re-requests', async () => {
    let attempts = 0;
    server.use(
      http.post(`${API_BASE}/index01/credentials`, () => {
        attempts += 1;
        return attempts === 1
          ? HttpResponse.json(
              { error: 'Invite code required — you are on the waitlist' },
              { status: 403 },
            )
          : HttpResponse.json(CREDENTIALS);
      }),
    );
    const user = userEvent.setup();
    await renderDesktop();
    await user.click(within(rowEl('pebble-index')).getByRole('button', { name: /connect/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/waitlist/);
    expect(screen.queryByTestId('pebble-setup-steps')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('pebble-setup-steps')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('closes with Done and reopening requests the credentials again', async () => {
    const served = serveCredentials();
    const user = userEvent.setup();
    await renderDesktop();
    const connect = () =>
      user.click(within(rowEl('pebble-index')).getByRole('button', { name: /connect/i }));
    await connect();
    await screen.findByTestId('pebble-setup-steps');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByTestId('pebble-setup-steps')).not.toBeInTheDocument());
    await connect();
    await screen.findByTestId('pebble-setup-steps');
    expect(served.calls).toBe(2);
  });

  it('is the last card on the stock page (flag off), after Granola, and opens the same setup', async () => {
    serveCredentials();
    const user = userEvent.setup();
    renderIntegrations({ roseDesktop: false });
    const connect = await screen.findByRole('button', { name: 'Connect Pebble Index 01' });
    const cards = connect.closest('.container')?.querySelector('.space-y-3')?.children;
    expect(cards?.[cards.length - 1]).toContainElement(connect);
    expect(cards?.[cards.length - 2]).toHaveTextContent('Granola');
    await user.click(connect);
    expect(await screen.findByTestId('pebble-setup-steps')).toBeInTheDocument();
  });
});
