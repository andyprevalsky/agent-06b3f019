import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import AdminHealth from '@/pages/AdminHealth';
import { fetchAdminHealthData } from '@/features/admin-health/api';
import { funnelEndToEnd } from '@/features/admin-health/components/AdminHealth';

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

function makeSeries() {
  return Array.from({ length: 12 }, (_, index) => ({
    key: `2026-0${(index % 9) + 1}-01`,
    label: `W${index + 1}`,
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-01-08T00:00:00.000Z',
    revenueCents: 10000 + index * 1000,
    waitlistSignups: 3 + index,
    userCount: 20 + index,
    newUsers: 2,
    taskCount: 10 + index,
    tasksIssuedPerUser: 0.8 + index / 10,
    outputTokensPerTask: 1200 + index * 80,
    taskCompletionRate: 0.7 + index / 100,
    andyLinearPoints: 3 + index,
    githubCommits: 12 + index,
    tamaraLinearPoints: 2 + index,
  }));
}

function makeFunnelSteps() {
  const definitions = [
    ['landing_page_viewed', 'Landing page viewed', 'client_analytics'],
    ['querybox_clicked', 'Query box clicked', 'client_analytics'],
    ['content_typed', 'Content typed', 'client_analytics'],
    ['goal_submitted', 'Goal submitted', 'client_analytics'],
    ['phone_entered', 'Phone entered / OTP requested', 'client_analytics'],
    ['otp_code_submitted', 'OTP code submitted', 'client_analytics'],
    ['account_created', 'Account created', 'database'],
    ['first_task_created', 'First task created', 'database'],
    ['second_task_created', 'Second task created', 'database'],
    ['third_task_created', 'Third task created', 'database'],
  ] as const;
  const counts = [100, 60, 50, 40, 30, 20, 14, 12, 8, 5];
  const previousCounts = [80, 48, 40, 32, 24, 16, 12, 10, 6, 4];
  return definitions.map(([id, label, source], index) => {
    const conversionRate = index === 0 ? 1 : counts[index] / counts[index - 1];
    const previousConversionRate =
      index === 0 ? 1 : previousCounts[index] / previousCounts[index - 1];
    return {
      id,
      label,
      source,
      status: 'ready' as const,
      count: counts[index],
      previousCount: previousCounts[index],
      conversionRate,
      previousConversionRate,
      conversionRateChange: (conversionRate - previousConversionRate) / previousConversionRate,
      detail: source === 'database' ? 'Database-backed.' : 'Amplitude-backed.',
    };
  });
}

function adminHealthPayload(timeSlice = 'monthly') {
  return {
    timeSlice,
    generatedAt: '2026-07-10T12:00:00.000Z',
    range: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-08T00:00:00.000Z',
    },
    historyRange: {
      start: '2025-10-16T00:00:00.000Z',
      end: '2026-01-08T00:00:00.000Z',
    },
    summary: {
      revenueCents: 184000,
      waitlistSignups: 14,
      userCount: 42,
      taskCount: 128,
      tasksIssuedPerUser: 3.05,
      outputTokensPerTask: 1840,
      taskCompletionRate: 0.82,
    },
    series: makeSeries(),
    retentionCohorts: [
      {
        cohortWeek: '2026-06-01',
        label: 'Jun 1',
        size: 8,
        points: [
          { week: 0, retainedUsers: 8, retentionRate: 1 },
          { week: 1, retainedUsers: 5, retentionRate: 0.625 },
        ],
      },
      {
        cohortWeek: '2026-06-08',
        label: 'Jun 8',
        size: 6,
        points: [
          { week: 0, retainedUsers: 6, retentionRate: 1 },
          { week: 1, retainedUsers: 3, retentionRate: 0.5 },
        ],
      },
    ],
    funnel: {
      steps: makeFunnelSteps(),
      endToEnd: {
        conversionRate: 0.05,
        previousConversionRate: 0.05,
        conversionRateChange: 0,
      },
    },
    velocity: {
      dev: {
        linearPointsCompleted: {
          label: 'Andy Linear points completed',
          value: 21,
          status: 'ready',
        },
        githubCommitsLanded: { label: 'GitHub commits landed', value: 37, status: 'ready' },
      },
      ops: {
        linearPointsCompleted: {
          label: 'Tamara Linear points completed',
          value: 13,
          status: 'ready',
        },
      },
    },
  };
}

function installAdminHealthHandler() {
  server.use(
    http.get(`${API_BASE}/admin-health`, ({ request }) => {
      const url = new URL(request.url);
      return HttpResponse.json(adminHealthPayload(url.searchParams.get('timeSlice') ?? 'weekly'));
    }),
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

    await waitFor(() => {
      expect(screen.getByText('Company Health')).toBeInTheDocument();
    });

    expect(screen.getAllByText('Revenue').length).toBeGreaterThan(0);
    expect(screen.getByText('01 Primary Metric')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Secondary metrics' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'General health metrics' })).toBeInTheDocument();
    expect(screen.queryByText('How secondary metrics connect to revenue')).not.toBeInTheDocument();
    expect(screen.getByText('$1,840')).toBeInTheDocument();
    expect(screen.getByText('Waitlist Signups')).toBeInTheDocument();
    expect(screen.getAllByText('14').length).toBeGreaterThan(0);
    expect(screen.getByText('Email and phone entries added this period.')).toBeInTheDocument();
    expect(screen.getByText('# of Users')).toBeInTheDocument();
    expect(screen.getAllByText('42').length).toBeGreaterThan(0);
    expect(screen.getByText('2 new users this period.')).toBeInTheDocument();
    expect(screen.getAllByText('Avg Tasks / User / 30 Days').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3.05').length).toBeGreaterThan(0);
    expect(
      screen.getByText('128 root tasks in the last 30 complete UTC days / 42 users.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Tasks and Users')).not.toBeInTheDocument();
    expect(screen.getByText('Output Tokens / Task')).toBeInTheDocument();
    expect(screen.getAllByText('1,840').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Task Completion Rate').length).toBeGreaterThan(0);
    expect(screen.getAllByText('82%').length).toBeGreaterThan(0);
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
