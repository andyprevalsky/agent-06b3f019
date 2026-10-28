/**
 * Blackbox tests for the Admin Health page and its metrics fetch layer.
 *
 * Covers:
 *   - full-page render of primary/secondary/general metrics, cost chart,
 *     connector adoption, conversion funnels, retention, and velocity
 *   - time-slice selection re-requests the endpoint with the admin bearer token
 *   - funnel end-to-end guard rejects anomalous current/prior growth
 *   - fetchAdminHealthData: no local/session caching, no cross-user reuse,
 *     unauthenticated rejection, backend-failure surfacing, timeout during parse
 *
 *   - the embedded user directory request starts with (not after) the metrics
 *     request; the panel-embedded page drops the standalone header gap and its
 *     neutral chart series follow the theme foreground
 *
 * The UsersSection directory that the page embeds is covered by
 * admin-health-users-list.blackbox.tsx and admin-health-users-invite.blackbox.tsx.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';

import AdminHealth from '@/pages/AdminHealth';
import { fetchAdminHealthData } from '@/features/admin-health/api';
import { funnelEndToEnd } from '@/features/admin-health/components/metricComparison';

import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import {
  API_BASE,
  adminHealthPayload,
  ChartResizeObserver,
  defaultResizeObserver,
  directoryResponse,
  installAdminHealthHandler,
  makeFunnelSteps,
  mockSession,
} from './admin-health.fixtures';

describe('AdminHealth page', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.ResizeObserver = ChartResizeObserver as unknown as typeof ResizeObserver;
    mockSession();
    installAdminHealthHandler();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.ResizeObserver = defaultResizeObserver;
  });

  it('renders company health metrics and charts from the admin endpoint', async () => {
    renderWithProviders(<AdminHealth />);

    // Header ("Company Health") paints while the metrics fetch is still in
    // flight — wait for post-load primary content, not the static title.
    await waitFor(() => {
      expect(screen.getByText('01 Primary Metric')).toBeInTheDocument();
    });

    expect(screen.getByText('Company Health')).toBeInTheDocument();
    expect(screen.getAllByText('Revenue').length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Secondary metrics' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'General health metrics' })).toBeInTheDocument();
    expect(screen.queryByText('How secondary metrics connect to revenue')).not.toBeInTheDocument();
    expect(screen.getByText('$1,840')).toBeInTheDocument();
    // Waitlist signups now renders as a chart in General Health Metrics (not a secondary card).
    expect(screen.getByText('Waitlist Signups')).toBeInTheDocument();
    expect(
      screen.getByText((text) => text.startsWith('Email + phone entries per')),
    ).toBeInTheDocument();
    expect(screen.getByText('# of People in App')).toBeInTheDocument();
    expect(screen.getAllByText('42').length).toBeGreaterThan(0);
    expect(screen.getByText('2 new people in app this period.')).toBeInTheDocument();
    expect(screen.getAllByText('Avg Tasks / User / 30 Days').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3.05').length).toBeGreaterThan(0);
    expect(
      screen.getByText('128 root tasks in the last 30 complete UTC days / 42 people in app.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Tasks and Users')).not.toBeInTheDocument();
    expect(screen.getByText('Output Tokens / Task')).toBeInTheDocument();
    expect(screen.getAllByText('1,840').length).toBeGreaterThan(0);
    expect(screen.getByText('GMV / Task')).toBeInTheDocument();
    expect(screen.getByText('GMV')).toBeInTheDocument();
    expect(screen.getByText('$256.00')).toBeInTheDocument();
    expect(screen.getByText('$2.00')).toBeInTheDocument();
    // Standalone per-metric charts folded into the secondary tiles' hover charts.
    expect(screen.queryByText('GMV Per Task')).not.toBeInTheDocument();
    expect(screen.queryByText('Output Tokens Per Task')).not.toBeInTheDocument();
    expect(screen.getAllByText('Task Completion Rate').length).toBeGreaterThan(0);
    expect(screen.getAllByText('82%').length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        'Completed / finished agent runs by Andy, Tamara, Aman and subscribed users in the selected period; a core-team retry of the same goal counts once. Running or archived-while-running tasks have no outcome yet; chat-only questions, benchmarks, test accounts and simulations are excluded.',
      ),
    ).toBeInTheDocument();
    // Cost labels/values appear in both the summary strip and chart legend.
    expect(screen.getAllByText('LLM at $0').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$0.0384').length).toBeGreaterThan(0);
    expect(screen.getAllByText('API rates (cache-aware)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$0.7594').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Compute-token rates').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$0.0745').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'Cost per root task over time' })).toBeInTheDocument();
    expect(
      screen.getByText((text) => text.includes('Current sample: 332 real root runs')),
    ).toBeInTheDocument();
    const connectorAdoption = screen.getByRole('region', { name: 'Connector Adoption' });
    expect(within(connectorAdoption).getByText('Browser Sync')).toBeInTheDocument();
    expect(within(connectorAdoption).getByText('Passwords')).toBeInTheDocument();
    expect(within(connectorAdoption).getByText('Compute')).toBeInTheDocument();
    expect(within(connectorAdoption).getByText('Messages')).toBeInTheDocument();
    expect(within(connectorAdoption).getByText('Socials')).toBeInTheDocument();
    expect(within(connectorAdoption).getByText('Financials')).toBeInTheDocument();
    expect(within(connectorAdoption).getByText('75%')).toBeInTheDocument();
    expect(
      within(connectorAdoption).getByText('18 of 24 people in app connected'),
    ).toBeInTheDocument();
    expect(screen.getByText('Conversion Funnels')).toBeInTheDocument();
    expect(screen.getByText('Website Acquisition')).toBeInTheDocument();
    expect(screen.getByText('New-Account Activation')).toBeInTheDocument();
    const acquisitionChart = screen.getByRole('img', {
      name: 'Website acquisition funnel volume',
    });
    const activationChart = screen.getByRole('img', {
      name: 'New-account activation funnel volume',
    });
    await waitFor(
      () => {
        expect(acquisitionChart.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(6);
        expect(activationChart.querySelectorAll('.recharts-bar-rectangle')).toHaveLength(4);
      },
      { timeout: 3_000 },
    );
    const acquisitionSteps = screen.getByRole('list', { name: 'Website acquisition steps' });
    const activationSteps = screen.getByRole('list', { name: 'New-account activation steps' });
    expect(within(acquisitionSteps).getByText('Landing page viewed')).toBeInTheDocument();
    expect(within(acquisitionSteps).getByText('Query box clicked')).toBeInTheDocument();
    expect(within(acquisitionSteps).getByText('Content typed')).toBeInTheDocument();
    expect(within(acquisitionSteps).getByText('Goal submitted')).toBeInTheDocument();
    expect(within(acquisitionSteps).getByText('Phone entered / OTP requested')).toBeInTheDocument();
    expect(within(acquisitionSteps).getByText('OTP code submitted')).toBeInTheDocument();
    expect(within(activationSteps).getByText('Account created')).toBeInTheDocument();
    expect(within(activationSteps).getByText('First task created')).toBeInTheDocument();
    expect(within(activationSteps).getByText('Second task created')).toBeInTheDocument();
    expect(within(activationSteps).getByText('Third task created')).toBeInTheDocument();
    expect(screen.getByText('Verified-User Weekly Retention')).toBeInTheDocument();
    expect(screen.getByText('Linear Points Completed')).toBeInTheDocument();
    expect(screen.getByText('GitHub Commits Landed')).toBeInTheDocument();
    expect(screen.getByText('Andy Linear points completed')).toBeInTheDocument();
    expect(screen.getByText('Tamara Linear points completed')).toBeInTheDocument();
    expect(screen.getByText('GitHub commits landed')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Linear points over time' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'GitHub commits over time' })).toBeInTheDocument();
    expect(screen.getAllByText('End-to-end conversion')).toHaveLength(2);
    expect(within(acquisitionSteps).getAllByRole('listitem')).toHaveLength(6);
    expect(within(activationSteps).getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getAllByText('Volume')).toHaveLength(10);
    expect(screen.getAllByText('Conversion')).toHaveLength(10);
    expect(screen.getAllByLabelText(/vs prior 30 days/).length).toBeGreaterThan(10);
  });

  it('shows "No finished tasks" instead of 0% when no task in the period has an outcome', async () => {
    server.use(
      http.get(`${API_BASE}/admin-health`, () => {
        const payload = adminHealthPayload('monthly');
        return HttpResponse.json({
          ...payload,
          summary: { ...payload.summary, taskCompletionRate: null },
          series: payload.series.map((point, index) =>
            index === payload.series.length - 1 ? { ...point, taskCompletionRate: null } : point,
          ),
        });
      }),
    );
    renderWithProviders(<AdminHealth />);

    const value = await screen.findByText('No finished tasks');
    // The tile's value slot (directly under its title) reads the empty state, not 0%.
    expect(value.previousElementSibling?.textContent).toBe('Task Completion Rate');
  });

  it('hovering or focusing a secondary metric shows its over-time chart, like Revenue', async () => {
    renderWithProviders(<AdminHealth />);
    await screen.findByText('01 Primary Metric');

    const titles = [
      '# of People in App',
      'Avg Tasks / User / 30 Days',
      'Output Tokens / Task',
      'GMV / Task',
      'Task Completion Rate',
    ];
    for (const title of titles) {
      const tile = screen.getByRole('group', { name: new RegExp(`^${escapeRegExp(title)}: `) });
      expect(screen.queryByRole('img', { name: `${title} over time` })).not.toBeInTheDocument();
      fireEvent.mouseEnter(tile);
      const chart = screen.getByRole('img', { name: `${title} over time` });
      // Same shared chart as the primary metric, plotted over the response's periods.
      expect(chart.querySelector('.recharts-responsive-container')).not.toBeNull();
      fireEvent.mouseLeave(tile);
      expect(screen.queryByRole('img', { name: `${title} over time` })).not.toBeInTheDocument();
      fireEvent.focus(tile);
      expect(screen.getByRole('img', { name: `${title} over time` })).toBeInTheDocument();
      // The hovered tile is lifted above later tiles/sections so the popover shows.
      expect(tile.className).toContain('z-30');
      fireEvent.keyDown(tile, { key: 'Escape' });
      expect(screen.queryByRole('img', { name: `${title} over time` })).not.toBeInTheDocument();
      fireEvent.blur(tile);
    }
  });

  it('requests the selected time slice with auth', async () => {
    const user = userEvent.setup();
    clearCaptures();
    renderWithProviders(<AdminHealth />);

    await waitFor(() => {
      expect(screen.getByText('Company Health')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        capturedRequests.some(
          (request) =>
            request.method === 'GET' &&
            request.url.includes('/admin-health?timeSlice=monthly') &&
            request.headers.authorization === 'Bearer admin-token',
        ),
      ).toBe(true);
    });

    await user.click(screen.getByRole('button', { name: 'Weekly' }));

    await waitFor(() => {
      expect(
        capturedRequests.some(
          (request) =>
            request.method === 'GET' &&
            request.url.includes('/admin-health?timeSlice=weekly') &&
            request.headers.authorization === 'Bearer admin-token',
        ),
      ).toBe(true);
    });
  });

  it('starts the user directory request with the metrics request, not after it', async () => {
    let releaseMetrics: () => void = () => undefined;
    const metricsHeld = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    let directoryRequested = false;
    server.use(
      http.get(`${API_BASE}/admin-health`, async ({ request }) => {
        await metricsHeld;
        const timeSlice = new URL(request.url).searchParams.get('timeSlice') ?? 'monthly';
        return HttpResponse.json(adminHealthPayload(timeSlice));
      }),
      http.get(`${API_BASE}/admin-health/users`, () => {
        directoryRequested = true;
        return HttpResponse.json(directoryResponse([]));
      }),
    );
    renderWithProviders(<AdminHealth />);
    // The metrics response is still held: the directory must already be in flight.
    await waitFor(() => expect(directoryRequested).toBe(true));
    expect(screen.queryByText('01 Primary Metric')).not.toBeInTheDocument();
    releaseMetrics();
    await screen.findByText('01 Primary Metric');
  });

  it('embedded in the Biz health panel: no standalone header gap; neutral series stay visible on dark', async () => {
    const { container, unmount } = renderWithProviders(<AdminHealth />);
    await screen.findByText('01 Primary Metric');
    expect(container.firstElementChild).toHaveClass('pt-20');
    unmount();

    const embedded = renderWithProviders(<AdminHealth embedded />);
    await screen.findByText('01 Primary Metric');
    await waitFor(() =>
      expect(document.querySelectorAll('[stroke="currentColor"]').length).toBeGreaterThan(0),
    );
    expect(embedded.container.firstElementChild).not.toHaveClass('pt-20');
    // A fixed near-black series (#111827) is invisible on the Rose dark panel (#262624).
    expect(document.querySelectorAll('[stroke="#111827"], [stop-color="#111827"]')).toHaveLength(0);
  });

  it('neutral-series tooltips use the theme popover tokens, so rows stay readable on dark', async () => {
    renderWithProviders(<AdminHealth embedded />);
    await screen.findByText('01 Primary Metric');
    const charts = [
      screen.getByText('Revenue over time'),
      screen.getByText('Verified-User Weekly Retention'),
      screen.getByRole('img', { name: 'GitHub commits over time' }),
    ].map((title) => {
      let node: HTMLElement | null = title;
      while (node !== null && node.querySelector('.recharts-wrapper') === null) {
        node = node.parentElement;
      }
      return node?.querySelector<HTMLElement>('.recharts-wrapper') ?? null;
    });
    let rows = 0;
    for (const chart of charts) {
      expect(chart).not.toBeNull();
      fireEvent.mouseMove(chart!, { clientX: 300, clientY: 100 });
      const box = await waitFor(() => {
        const found = chart!.querySelector<HTMLElement>('.recharts-default-tooltip');
        expect(found).not.toBeNull();
        return found!;
      });
      // Recharts' default box is a fixed #fff; rows take the series colour
      // (currentColor = light text on Rose dark) unless the item style is themed.
      const style = box.getAttribute('style') ?? '';
      expect(style).toContain('hsl(var(--popover))');
      expect(style).not.toMatch(/rgb\(255, 255, 255\)|#fff/);
      const label = box.querySelector<HTMLElement>('.recharts-tooltip-label');
      expect(label?.getAttribute('style') ?? '').toContain('hsl(var(--popover-foreground))');
      for (const row of box.querySelectorAll<HTMLElement>('.recharts-tooltip-item')) {
        rows += 1;
        expect(row.getAttribute('style') ?? '').toContain('hsl(var(--popover-foreground))');
        expect(row.getAttribute('style') ?? '').not.toContain('currentcolor');
      }
    }
    expect(rows).toBeGreaterThan(0);
  });

  it('rejects anomalous end-to-end funnel growth in current and prior periods', () => {
    const currentAnomaly = makeFunnelSteps().slice(0, 6);
    currentAnomaly[5].count = currentAnomaly[0].count + 1;
    expect(funnelEndToEnd(currentAnomaly)).toEqual({
      conversionRate: null,
      conversionRateChange: null,
    });

    const priorAnomaly = makeFunnelSteps().slice(0, 6);
    priorAnomaly[5].previousCount = priorAnomaly[0].previousCount + 1;
    expect(funnelEndToEnd(priorAnomaly)).toEqual({
      conversionRate: 0.2,
      conversionRateChange: null,
    });
  });

  it('delegates reusable caching to the backend without persisting admin metrics locally', async () => {
    clearCaptures();
    await fetchAdminHealthData('weekly');
    await fetchAdminHealthData('weekly');

    const requests = capturedRequests.filter(
      (request) =>
        request.method === 'GET' && request.url.includes('/admin-health?timeSlice=weekly'),
    );
    expect(requests).toHaveLength(2);
    expect(Object.keys(localStorage).some((key) => key.startsWith('admin-health:'))).toBe(false);
    expect(Object.keys(sessionStorage).some((key) => key.startsWith('admin-health:'))).toBe(false);
  });

  it('does not share cached admin metrics across authenticated users', async () => {
    clearCaptures();
    await fetchAdminHealthData('weekly');
    const nextSession = JSON.parse(localStorage.getItem('rose-session') ?? '{}') as {
      user: { id: string };
    };
    nextSession.user.id = 'another-admin';
    localStorage.setItem('rose-session', JSON.stringify(nextSession));
    await fetchAdminHealthData('weekly');

    const requests = capturedRequests.filter(
      (request) =>
        request.method === 'GET' && request.url.includes('/admin-health?timeSlice=weekly'),
    );
    expect(requests).toHaveLength(2);
  });

  it('returns live data when session caching is unavailable', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage unavailable', 'QuotaExceededError');
    });

    try {
      await expect(fetchAdminHealthData('weekly')).resolves.toMatchObject({ timeSlice: 'weekly' });
    } finally {
      setItem.mockRestore();
    }
  });

  it('rejects unauthenticated requests before calling the backend', async () => {
    localStorage.removeItem('rose-session');
    clearCaptures();

    await expect(fetchAdminHealthData('weekly')).rejects.toThrow('Not authenticated');
    expect(
      capturedRequests.some(
        (request) =>
          request.method === 'GET' && request.url.includes('/admin-health?timeSlice=weekly'),
      ),
    ).toBe(false);
  });

  it('surfaces backend failures instead of rendering stale health data', async () => {
    server.use(
      http.get(`${API_BASE}/admin-health`, () =>
        HttpResponse.json({ error: 'metrics unavailable' }, { status: 503 }),
      ),
    );

    await expect(fetchAdminHealthData('weekly')).rejects.toThrow(
      'Failed to load admin health (503)',
    );
  });

  it('keeps the request timeout active while parsing the response body', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      return {
        ok: true,
        json: () =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      } as Response;
    });

    try {
      const request = expect(fetchAdminHealthData('weekly')).rejects.toMatchObject({
        name: 'AbortError',
      });
      await vi.advanceTimersByTimeAsync(15_000);
      await request;
    } finally {
      fetchMock.mockRestore();
      vi.useRealTimers();
    }
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
