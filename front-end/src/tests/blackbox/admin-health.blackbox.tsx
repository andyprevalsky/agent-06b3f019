import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import { Toaster } from '@/components/ui/toaster';
import AdminHealth from '@/pages/AdminHealth';
import { fetchAdminHealthData } from '@/features/admin-health/api';
import { funnelEndToEnd } from '@/features/admin-health/components/metricComparison';
import UsersSection from '@/features/admin-health/components/UsersSection';
import type { AdminDirectoryPerson } from '@/lib/adminUsers';
import { adminHealthPayload, makeFunnelSteps, makeSeries } from './admin-health.fixtures';

const API_BASE = 'http://localhost:3001/api';
const defaultResizeObserver = window.ResizeObserver;

class ChartResizeObserver {
  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element) {
    this.callback(
      [
        {
          target,
          contentRect: { width: 1200, height: 420 } as DOMRectReadOnly,
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }

  unobserve() {}
  disconnect() {}
}

function mockSession() {
  localStorage.setItem(
    'rose-session',
    JSON.stringify({
      access_token: 'admin-token',
      refresh_token: 'test-refresh',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: 'bearer',
      user: { id: '1f85ff25-6e29-4c1b-8739-f917bd101a30' },
    }),
  );
}

function installAdminHealthHandler() {
  server.use(
    http.get(`${API_BASE}/admin-health`, ({ request }) => {
      const url = new URL(request.url);
      return HttpResponse.json(adminHealthPayload(url.searchParams.get('timeSlice') ?? 'weekly'));
    }),
    // The Waitlist People section fetches this on mount; default to empty so the
    // full-page tests don't trip the onUnhandledRequest guard.
    http.get(`${API_BASE}/admin-health/users`, () => HttpResponse.json(directoryResponse([]))),
  );
}

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
    expect(screen.getByText('GMV Per Task')).toBeInTheDocument();
    expect(screen.getAllByText('Task Completion Rate').length).toBeGreaterThan(0);
    expect(screen.getAllByText('82%').length).toBeGreaterThan(0);
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

function directoryPerson(overrides: Partial<AdminDirectoryPerson> = {}): AdminDirectoryPerson {
  return {
    key: 'user:acct-1',
    userId: 'acct-1',
    waitlistId: 'wl-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    phone: '+13234498210',
    joinedAt: '2026-07-01T00:00:00.000Z',
    invitedAt: null,
    hasAccount: true,
    hasSubscription: false,
    isGated: true,
    isAdmin: false,
    ...overrides,
  };
}

function directoryResponse(
  people: AdminDirectoryPerson[],
  options: { total?: number; page?: number; pageSize?: number; search?: string } = {},
) {
  const total = options.total ?? people.length;
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 50;
  return {
    people,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    search: options.search ?? '',
  };
}

describe('UsersSection', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockSession();
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('texts and emails an invite, then pulls the person off the waitlist', async () => {
    clearCaptures();
    server.use(
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json(directoryResponse([directoryPerson()])),
      ),
      http.post(`${API_BASE}/admin-health/waitlist/:id/invite`, ({ params }) =>
        HttpResponse.json({
          id: params.id,
          invitedAt: '2026-07-17T00:00:00.000Z',
          smsSent: true,
          emailSent: true,
          flagged: true,
          alreadyOffWaitlist: false,
          hasAccount: true,
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersSection />);

    const inviteButton = await screen.findByRole('button', { name: /Invite, text & email/ });
    await user.click(inviteButton);

    await waitFor(() => {
      expect(
        capturedRequests.some(
          (request) =>
            request.method === 'POST' &&
            request.url.includes('/admin-health/waitlist/wl-1/invite') &&
            request.headers.authorization === 'Bearer admin-token',
        ),
      ).toBe(true);
    });

    // Row flips to the invited state and is no longer marked as gated.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Re-send/ })).toBeInTheDocument();
    });
    expect(screen.getByText('Invited')).toBeInTheDocument();
    expect(screen.queryByText('On waitlist')).not.toBeInTheDocument();
  });

  it('reuses one idempotency key for a failed attempt and changes it after success', async () => {
    clearCaptures();
    let attempts = 0;
    server.use(
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json(directoryResponse([directoryPerson()])),
      ),
      http.post(`${API_BASE}/admin-health/waitlist/:id/invite`, ({ params }) => {
        attempts += 1;
        if (attempts === 1) {
          return HttpResponse.json({ error: 'temporary delivery failure' }, { status: 502 });
        }
        return HttpResponse.json({
          id: params.id,
          invitedAt: '2026-07-17T00:00:00.000Z',
          smsSent: true,
          emailSent: true,
          flagged: true,
          alreadyOffWaitlist: false,
          hasAccount: true,
        });
      }),
    );

    const user = userEvent.setup();
    renderWithProviders(<UsersSection />);
    const inviteButton = await screen.findByRole('button', { name: /Invite, text & email/ });
    await user.click(inviteButton);
    await waitFor(() => expect(attempts).toBe(1));
    await waitFor(() => expect(inviteButton).toBeEnabled());
    await user.click(inviteButton);
    await waitFor(() => expect(attempts).toBe(2));

    const firstTwo = capturedRequests.filter(
      (request) => request.method === 'POST' && request.url.includes('/waitlist/wl-1/invite'),
    );
    expect(firstTwo).toHaveLength(2);
    expect(firstTwo[0].headers['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{1,200}$/);
    expect(firstTwo[1].headers['idempotency-key']).toBe(firstTwo[0].headers['idempotency-key']);

    await user.click(await screen.findByRole('button', { name: /Re-send/ }));
    await waitFor(() => expect(attempts).toBe(3));
    const allInvites = capturedRequests.filter(
      (request) => request.method === 'POST' && request.url.includes('/waitlist/wl-1/invite'),
    );
    expect(allInvites[2].headers['idempotency-key']).not.toBe(
      allInvites[1].headers['idempotency-key'],
    );
  });

  it('describes a no-account invite outcome without claiming the account was flagged', async () => {
    server.use(
      http.get(`${API_BASE}/admin-health/users`, () =>
        HttpResponse.json(
          directoryResponse([
            directoryPerson({
              userId: null,
              key: 'waitlist:wl-1',
              hasAccount: false,
              isGated: false,
            }),
          ]),
        ),
      ),
      http.post(`${API_BASE}/admin-health/waitlist/:id/invite`, ({ params }) =>
        HttpResponse.json({
          id: params.id,
          invitedAt: '2026-07-17T00:00:00.000Z',
          smsSent: true,
          emailSent: false,
          flagged: false,
          alreadyOffWaitlist: false,
          hasAccount: false,
        }),
      ),
    );

    const user = userEvent.setup();
    renderWithProviders(
      <>
        <UsersSection />
        <Toaster />
      </>,
    );
    await user.click(await screen.findByRole('button', { name: /Invite, text & email/ }));

    expect(await screen.findByText(/no account available to flag/i)).toBeInTheDocument();
    expect(screen.queryByText(/flagged to subscribe/i)).not.toBeInTheDocument();
  });
});
