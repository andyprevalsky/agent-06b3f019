/**
 * Compute subscriptions (Rose Desktop): one line per account with a 7d bar of
 * the quota left, and a ⋯ menu holding that account's actions.
 *
 * Contract: GET /api/compute-accounts → accounts[] with
 *   usage: { fiveHour, sevenDay: { usedPct, resetsAt } | null, observedAt } | null
 *   rateLimitedUntil: ISO | null
 * Usage is what agents last reported on the account's token, so an account no
 * agent has used is unknown (never drawn as full). A cooldown or an empty 7d
 * window is exhausted (red); a window whose reset has passed counts as full.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import { usageMeterView } from '@/features/integrations/components/subscriptionUsage';

import {
  API_BASE,
  desktopHandlers,
  listOf,
  renderDesktop,
  rowEl,
  serveList,
} from './integrations-accounts.fixtures';
import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

interface AccountOverrides {
  state?: string;
  usage?: unknown;
  rateLimitedUntil?: string | null;
}

function computeAccount(accountId: string, accountEmail: string, extra: AccountOverrides = {}) {
  return {
    provider: 'claude',
    accountId,
    accountEmail,
    state: 'connected',
    lastErrorReason: null,
    connectedAt: '2026-10-01T00:00:00Z',
    usage: null,
    rateLimitedUntil: null,
    ...extra,
  };
}

const weekly = (usedPct: number, resetsAt: string | null) => ({
  fiveHour: { usedPct: 10, resetsAt: iso(2 * HOUR) },
  sevenDay: { usedPct, resetsAt },
  observedAt: iso(-60_000),
});

function serveCompute(accounts: ReturnType<typeof computeAccount>[]) {
  server.use(
    http.get(`${API_BASE}/compute-accounts`, () => HttpResponse.json({ accounts })),
    http.delete(`${API_BASE}/compute-accounts/:provider/:accountId`, () =>
      HttpResponse.json({ ok: true }),
    ),
    http.post(`${API_BASE}/compute-accounts/connect`, () =>
      HttpResponse.json({
        connectId: 'c-1',
        provider: 'claude',
        liveViewUrl: null,
        expiresAt: iso(HOUR),
      }),
    ),
  );
}

/** `connect: false` = the web build, which has no Mac-app sign-in bridge. */
async function renderCompute(accounts: ReturnType<typeof computeAccount>[], connect = true) {
  serveList(() => listOf());
  serveCompute(accounts);
  const claudeCode = {
    isAvailable: true,
    hasCredentials: async () => false,
    syncCredentials: async () => ({ success: true }),
  };
  await renderDesktop({ handlers: desktopHandlers(connect ? { claudeCode } : {}) });
  await waitFor(() =>
    expect(within(rowEl('claude')).getAllByTestId('account-row')).toHaveLength(accounts.length),
  );
}

const lineFor = (label: string) => {
  const line = within(rowEl('claude')).getByText(label).closest('li');
  if (line === null) throw new Error(`no account line for ${label}`);
  return line;
};
const meterOf = (label: string) => within(lineFor(label)).getByTestId('usage-meter');

describe('compute subscription usage bars', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('puts each account on its own line with a 7d bar of the quota left', async () => {
    await renderCompute([
      computeAccount('acct-1', 'work@roselabs.ai', { usage: weekly(30, iso(3 * 24 * HOUR)) }),
      computeAccount('acct-2', 'ops@roselabs.ai', { rateLimitedUntil: iso(2 * 24 * HOUR) }),
      computeAccount('acct-3', 'new@roselabs.ai'),
    ]);

    const ok = meterOf('work@roselabs.ai');
    expect(ok).toHaveAttribute('data-usage-tone', 'ok');
    expect(within(ok).getByText('7d')).toBeInTheDocument();
    expect(within(ok).getByRole('meter')).toHaveAttribute('aria-valuenow', '70');
    expect(ok.getAttribute('title')).toMatch(/^7d: 70% left · resets .+\n5h: 90% left/);

    const limited = meterOf('ops@roselabs.ai');
    expect(limited).toHaveAttribute('data-usage-tone', 'exhausted');
    expect(within(limited).getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
    expect(limited.getAttribute('title')).toMatch(/^Rate-limited until /);

    const unused = meterOf('new@roselabs.ai');
    expect(unused).toHaveAttribute('data-usage-tone', 'unknown');
    expect(within(unused).getByRole('meter')).not.toHaveAttribute('aria-valuenow');
    expect(unused).toHaveAttribute('title', 'No usage reported yet');

    expect(
      within(rowEl('claude')).getByRole('button', { name: 'Add Claude Subscription account' }),
    ).toBeInTheDocument();
  });

  it('⋯ holds Re-authenticate and Remove; Remove deletes exactly that account', async () => {
    const user = userEvent.setup();
    await renderCompute([
      computeAccount('acct-1', 'work@roselabs.ai'),
      computeAccount('acct-2', 'ops@roselabs.ai'),
    ]);

    await user.click(
      within(lineFor('ops@roselabs.ai')).getByRole('button', { name: 'ops@roselabs.ai options' }),
    );
    const menu = await screen.findByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Re-authenticate', 'Remove']);
    expect(items[1]).toHaveAccessibleName('Remove Claude account ops@roselabs.ai');
    await user.click(items[1]);

    await waitFor(() =>
      expect(
        capturedRequests.filter((r) => r.method === 'DELETE').map((r) => new URL(r.url).pathname),
      ).toEqual(['/api/compute-accounts/claude/acct-2']),
    );
  });

  it('keeps the needs-reconnect status; Re-authenticate starts sign-in', async () => {
    const user = userEvent.setup();
    await renderCompute([
      computeAccount('acct-1', 'stale@roselabs.ai', {
        state: 'needs_reconnect',
        usage: weekly(20, iso(3 * 24 * HOUR)),
      }),
    ]);
    // The needs-reconnect status survives the row layout, beside its usage bar.
    const line = lineFor('stale@roselabs.ai');
    expect(line).toHaveAttribute('data-tone', 'warning');
    expect(within(line).getByText('· Reconnect')).toBeInTheDocument();
    expect(within(line).getByTestId('usage-meter')).toHaveAttribute('data-usage-tone', 'ok');

    await user.click(
      within(lineFor('stale@roselabs.ai')).getByRole('button', {
        name: 'stale@roselabs.ai options',
      }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'Re-authenticate' }));

    await waitFor(() =>
      expect(
        capturedRequests.some(
          (r) => r.method === 'POST' && r.url.endsWith('/api/compute-accounts/connect'),
        ),
      ).toBe(true),
    );
  });

  it('offers only Remove on the web, where there is no sign-in bridge', async () => {
    const user = userEvent.setup();
    await renderCompute([computeAccount('acct-1', 'web@roselabs.ai')], false);
    await user.click(
      within(lineFor('web@roselabs.ai')).getByRole('button', { name: 'web@roselabs.ai options' }),
    );
    const menu = await screen.findByRole('menu');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Remove']);
  });
});

describe('usageMeterView', () => {
  it('counts a window whose reset has passed as fully remaining', () => {
    const view = usageMeterView({ usage: weeklyAt(100, NOW - HOUR), rateLimitedUntil: null }, NOW);
    expect(view).toMatchObject({ tone: 'ok', remainingPct: 100 });
  });

  it('marks an emptied 7d window exhausted even without a cooldown', () => {
    const view = usageMeterView({ usage: weeklyAt(100, NOW + HOUR), rateLimitedUntil: null }, NOW);
    expect(view).toMatchObject({ tone: 'exhausted', remainingPct: 0 });
  });

  it('ignores a cooldown that has already passed', () => {
    const view = usageMeterView(
      { usage: weeklyAt(25, NOW + HOUR), rateLimitedUntil: new Date(NOW - 1).toISOString() },
      NOW,
    );
    expect(view).toMatchObject({ tone: 'ok', remainingPct: 75 });
    expect(view.title).not.toMatch(/Rate-limited/);
  });

  it('clamps out-of-range usage', () => {
    expect(
      usageMeterView({ usage: weeklyAt(140, NOW + HOUR), rateLimitedUntil: null }, NOW)
        .remainingPct,
    ).toBe(0);
    expect(
      usageMeterView({ usage: weeklyAt(-5, NOW + HOUR), rateLimitedUntil: null }, NOW).remainingPct,
    ).toBe(100);
  });
});

function weeklyAt(usedPct: number, resetsAtMs: number) {
  return {
    fiveHour: null,
    sevenDay: { usedPct, resetsAt: new Date(resetsAtMs).toISOString() },
    observedAt: new Date(NOW - HOUR).toISOString(),
  };
}
