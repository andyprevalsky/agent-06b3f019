/**
 * Compute subscriptions (Rose Desktop): one line per account with a 7d bar of
 * the quota left, and a ⋯ menu holding that account's actions.
 *
 * Contract: GET /api/compute-accounts → accounts[] with
 *   usage: { fiveHour, sevenDay: { usedPct, resetsAt } | null, observedAt,
 *            source?, status? } | null
 *   rateLimitedUntil: ISO | null
 *   cooldown?: { until, reason, authoritative } | null   (newer backends)
 *   nextResetAt?: ISO | null                             (newer backends)
 * Usage is what agents last reported on the account's token, so an account no
 * agent has used is unknown ("No data yet", never drawn as full or zero). An
 * authoritative cooldown or a used-up window is exhausted (red) with the reset
 * as visible text; a Rose backoff (or a bare legacy rateLimitedUntil) is
 * cooling, never red; a window whose reset has passed counts as full.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import {
  advance,
  API_BASE,
  computeAccount,
  cooldown,
  desktopHandlers,
  listOf,
  renderDesktop,
  rowEl,
  serveList,
  weekly,
} from './integrations-accounts.fixtures';
import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { mockTerminalHookSession as mockSession } from './terminal-hooks.fixtures';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

type Account = ReturnType<typeof computeAccount>;

/**
 * Serves `accounts` to the Claude row (the ChatGPT row gets none). `accounts` may be
 * a function so a test can change the list (or fail) between fetches.
 */
function serveCompute(accounts: Account[] | (() => Account[] | Response)) {
  const list = typeof accounts === 'function' ? accounts : () => accounts;
  server.use(
    http.get(`${API_BASE}/compute-accounts`, ({ request }) => {
      if (new URL(request.url).searchParams.get('provider') !== 'claude') {
        return HttpResponse.json({ accounts: [] });
      }
      const body = list();
      return body instanceof Response ? body : HttpResponse.json({ accounts: body });
    }),
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
    http.get(`${API_BASE}/compute-accounts/connect/:connectId`, () =>
      HttpResponse.json({ state: 'pending' }),
    ),
    http.delete(`${API_BASE}/compute-accounts/connect/:connectId`, () =>
      HttpResponse.json({ ok: true }),
    ),
  );
}

/** `connect: false` = the web build, which has no Mac-app sign-in bridge. */
async function renderCompute(
  accounts: Account[] | (() => Account[] | Response),
  connect = true,
  expected = typeof accounts === 'function' ? null : accounts.length,
) {
  serveList(() => listOf());
  serveCompute(accounts);
  const claudeCode = {
    isAvailable: true,
    hasCredentials: async () => false,
    syncCredentials: async () => ({ success: true }),
  };
  await renderDesktop({ handlers: desktopHandlers(connect ? { claudeCode } : {}) });
  if (expected !== null) {
    await waitFor(() =>
      expect(within(rowEl('claude')).getAllByTestId('account-row')).toHaveLength(expected),
    );
  }
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

    // An old backend's bare rateLimitedUntil may be a Rose default or stall backoff:
    // a visible pause hint, never claimed exhausted.
    const limited = meterOf('ops@roselabs.ai');
    expect(limited).toHaveAttribute('data-usage-tone', 'cooling');
    expect(within(limited).getByTestId('usage-status')).toHaveTextContent(/^paused until /);
    expect(limited.getAttribute('title')).toMatch(/^Rate-limited until .+ \(reset not confirmed\)/);

    const unused = meterOf('new@roselabs.ai');
    expect(unused).toHaveAttribute('data-usage-tone', 'unknown');
    expect(within(unused).getByRole('meter')).not.toHaveAttribute('aria-valuenow');
    expect(within(unused).getByText('No data yet')).toBeVisible();
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

    // While that sign-in runs, a second Re-authenticate cannot start another connect (which
    // would replace the first one's remote browser); Remove stays available.
    await user.click(
      within(lineFor('stale@roselabs.ai')).getByRole('button', {
        name: 'stale@roselabs.ai options',
      }),
    );
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Re-authenticate' })).toBeDisabled();
    expect(
      within(menu).getByRole('menuitem', { name: 'Remove Claude account stale@roselabs.ai' }),
    ).toBeEnabled();
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

describe('compute usage bars on the row', () => {
  beforeEach(() => mockSession());
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('renders the reset time, hints and "No data yet" as visible text, not only a tooltip', async () => {
    // A fixed midday clock: "soon" (+1h) must stay on today's date, or the bar
    // rightly shows "Nov 13" instead of a time (failed when run after 23:00).
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    const soon = Date.now() + HOUR;
    const weekReset = Date.now() + 3 * 24 * HOUR;
    await renderCompute([
      computeAccount('a1', 'capped@roselabs.ai', {
        usage: weekly(100, new Date(weekReset).toISOString(), {
          source: 'rate_limit',
          status: 'rejected',
        }),
        rateLimitedUntil: new Date(soon).toISOString(),
        cooldown: cooldown(new Date(soon).toISOString(), 'usage_window_5h', true),
        nextResetAt: new Date(soon).toISOString(),
      }),
      computeAccount('a2', 'stalled@roselabs.ai', {
        usage: weekly(30, iso(3 * 24 * HOUR)),
        rateLimitedUntil: iso(10 * 60_000),
        cooldown: cooldown(iso(10 * 60_000), 'stall', false),
        nextResetAt: null,
      }),
      computeAccount('a3', 'fresh@roselabs.ai', {
        usage: weekly(25, iso(3 * 24 * HOUR)),
        cooldown: null,
        nextResetAt: null,
      }),
      computeAccount('a4', 'old@roselabs.ai', {
        usage: weekly(25, iso(3 * 24 * HOUR), { observedAt: iso(-8 * HOUR) }),
        cooldown: null,
      }),
      computeAccount('a5', 'empty@roselabs.ai', { cooldown: null, nextResetAt: null }),
      computeAccount('a6', 'fivehour@roselabs.ai', {
        usage: {
          fiveHour: { usedPct: 100, resetsAt: new Date(soon).toISOString() },
          sevenDay: { usedPct: 60, resetsAt: iso(4 * 24 * HOUR) },
          observedAt: iso(-60_000),
        },
        cooldown: null,
        nextResetAt: new Date(soon).toISOString(),
      }),
    ]);

    const capped = meterOf('capped@roselabs.ai');
    expect(capped).toHaveAttribute('data-usage-tone', 'exhausted');
    // The weekly window is spent: the 1h 5h cooldown does not unblock it, so the
    // visible reset is the weekly one.
    expect(within(capped).getByText(`resets ${day(weekReset)}`)).toBeVisible();
    expect(within(capped).getByRole('meter')).toHaveAttribute(
      'aria-valuetext',
      `Quota used up, resets ${day(weekReset)}, ${clock(weekReset)}`,
    );
    expect(within(capped).queryByTestId('usage-fill')).toBeNull();

    const stalled = meterOf('stalled@roselabs.ai');
    expect(stalled).toHaveAttribute('data-usage-tone', 'cooling');
    expect(within(stalled).getByText('retry in 10m')).toBeVisible();
    expect(within(stalled).getByTestId('usage-fill')).toHaveStyle({ width: '70%' });

    const fresh = meterOf('fresh@roselabs.ai');
    expect(fresh).toHaveAttribute('data-usage-tone', 'ok');
    expect(fresh).not.toHaveAttribute('data-usage-stale');
    expect(within(fresh).getByTestId('usage-fill')).toHaveStyle({ width: '75%' });
    expect(within(fresh).queryByTestId('usage-status')).toBeNull();

    const old = meterOf('old@roselabs.ai');
    expect(old).toHaveAttribute('data-usage-stale', 'true');
    expect(old.getAttribute('title')).toMatch(/as of 8h ago$/);
    expect(within(old).getByTestId('usage-fill')).toHaveClass('opacity-50');

    const empty = meterOf('empty@roselabs.ai');
    expect(empty).toHaveAttribute('data-usage-tone', 'unknown');
    expect(within(empty).getByText('No data yet')).toBeVisible();
    expect(within(empty).queryByText(/0%/)).toBeNull();

    // Only the 5h window is spent: red with its visible reset, yet the weekly
    // remainder (40%) is still drawn rather than emptied.
    const fiveHour = meterOf('fivehour@roselabs.ai');
    expect(fiveHour).toHaveAttribute('data-usage-tone', 'exhausted');
    expect(within(fiveHour).getByText(`resets ${clock(soon)}`)).toBeVisible();
    expect(within(fiveHour).getByRole('meter')).toHaveAttribute('aria-valuenow', '40');
    expect(within(fiveHour).getByTestId('usage-fill')).toHaveStyle({ width: '40%' });
  });

  it('keeps a foreground list when a newer background refetch fails', async () => {
    const list = racingClaudeList((mode) =>
      mode === 'fail'
        ? HttpResponse.json({ error: 'down' }, { status: 503 })
        : HttpResponse.json({ accounts: [computeAccount('a1', 'kept@roselabs.ai')] }),
    );
    await renderDesktop({ handlers: desktopHandlers({}) });
    await waitFor(() => expect(list.calls).toContain('hold'));
    // A background refetch starts after the foreground load and fails first...
    list.mode = 'fail';
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(list.calls).toContain('fail'));
    // ...then the foreground load succeeds: its list is shown, not discarded.
    list.release();
    await waitFor(() =>
      expect(within(rowEl('claude')).getByText('kept@roselabs.ai')).toBeVisible(),
    );
    expect(within(rowEl('claude')).queryByText(/Failed to load compute accounts/)).toBeNull();
  });

  it('a superseded foreground failure never shows an error beside a newer list', async () => {
    const list = racingClaudeList((mode) =>
      mode === 'ok'
        ? HttpResponse.json({ accounts: [computeAccount('a1', 'newer@roselabs.ai')] })
        : HttpResponse.json({ error: 'down' }, { status: 503 }),
    );
    await renderDesktop({ handlers: desktopHandlers({}) });
    await waitFor(() => expect(list.calls).toContain('hold'));
    // A newer background refetch succeeds first...
    list.mode = 'ok';
    window.dispatchEvent(new Event('focus'));
    await waitFor(() =>
      expect(within(rowEl('claude')).getByText('newer@roselabs.ai')).toBeVisible(),
    );
    // ...then the older foreground load fails: the newer list stands, with no error.
    list.release();
    await act(async () => {
      await Promise.allSettled(list.responses);
      // One task turn lets the hook's catch run after its fetch settled.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(within(rowEl('claude')).getByText('newer@roselabs.ai')).toBeVisible();
    expect(within(rowEl('claude')).queryByText(/Failed to load compute accounts/)).toBeNull();
  });

  it('refetches every 60s while mounted and visible; not while hidden or after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: NOW });
    await renderCompute([computeAccount('a1', 'work@roselabs.ai', { cooldown: null })]);
    const fetches = () =>
      capturedRequests.filter((r) => {
        const url = new URL(r.url);
        return (
          url.pathname === '/api/compute-accounts' && url.searchParams.get('provider') === 'claude'
        );
      }).length;
    const initial = fetches();
    // vi.waitFor polls on real timers: a refetch that changes nothing in the DOM
    // would never wake testing-library's waitFor while intervals are faked.

    await advance(60_000);
    await vi.waitFor(() => expect(fetches()).toBe(initial + 1));

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await advance(120_000);
    expect(fetches()).toBe(initial + 1);

    // Coming back into view refetches at once.
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(fetches()).toBe(initial + 2));

    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(fetches()).toBe(initial + 3));

    cleanup();
    await advance(180_000);
    expect(fetches()).toBe(initial + 3);
  });

  it('an expired cooldown flips on the 30s tick with no new data; a failed refetch keeps the list', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: NOW });
    const until = iso(20_000);
    let calls = 0;
    await renderCompute(
      () => {
        calls += 1;
        // Only the first load succeeds: every refetch after it fails.
        if (calls > 1) return HttpResponse.error();
        return [
          computeAccount('a1', 'work@roselabs.ai', {
            usage: weekly(30, iso(3 * 24 * HOUR)),
            rateLimitedUntil: until,
            cooldown: cooldown(until, 'rate_limit', true),
            nextResetAt: until,
          }),
        ];
      },
      true,
      1,
    );
    expect(meterOf('work@roselabs.ai')).toHaveAttribute('data-usage-tone', 'exhausted');

    await advance(30_000);
    // The passed deadline triggered a refetch, which failed...
    await vi.waitFor(() => expect(calls).toBeGreaterThan(1));
    // ...yet the row is intact, flipped to OK by the tick alone, with no error shown.
    await waitFor(() =>
      expect(meterOf('work@roselabs.ai')).toHaveAttribute('data-usage-tone', 'ok'),
    );
    expect(within(meterOf('work@roselabs.ai')).getByRole('meter')).toHaveAttribute(
      'aria-valuenow',
      '70',
    );
    expect(within(rowEl('claude')).queryByText(/Failed to load compute accounts/)).toBeNull();

    await advance(60_000);
    expect(within(rowEl('claude')).getAllByTestId('account-row')).toHaveLength(1);
  });

  it('refetches once the earliest shown deadline passes and shows the new state', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], now: NOW });
    const until = iso(10_000);
    let calls = 0;
    await renderCompute(
      () => {
        calls += 1;
        return [
          computeAccount('a1', 'work@roselabs.ai', {
            usage: calls === 1 ? weekly(100, until) : weekly(5, iso(7 * 24 * HOUR)),
            cooldown: null,
            nextResetAt: calls === 1 ? until : null,
          }),
        ];
      },
      true,
      1,
    );
    expect(meterOf('work@roselabs.ai')).toHaveAttribute('data-usage-tone', 'exhausted');
    await advance(30_000);
    await vi.waitFor(() => expect(calls).toBe(2));
    await waitFor(() =>
      expect(within(meterOf('work@roselabs.ai')).getByRole('meter')).toHaveAttribute(
        'aria-valuenow',
        '95',
      ),
    );
  });
});

/**
 * Claude list requests answered by `answer(mode)`, where `mode` is the value of
 * `list.mode` when the request arrived; requests that arrive in 'hold' wait for
 * `list.release()`. `responses` are the client's own fetches of the list, so a
 * test can wait until each has settled in the page.
 */
function racingClaudeList(answer: (mode: string) => Response) {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const list = { mode: 'hold', calls: [] as string[], responses: [] as Promise<void>[], release };
  serveList(() => listOf());
  serveCompute([]);
  server.use(
    http.get(`${API_BASE}/compute-accounts`, ({ request }) => {
      if (new URL(request.url).searchParams.get('provider') !== 'claude') {
        return HttpResponse.json({ accounts: [] });
      }
      const mode = list.mode;
      list.calls.push(mode);
      return (mode === 'hold' ? held : Promise.resolve()).then(() => answer(mode));
    }),
  );
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const pending = realFetch(input, init);
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('/compute-accounts?provider=claude')) {
      list.responses.push(pending.then(() => undefined));
    }
    return pending;
  });
  list.release = () => release();
  return list;
}
