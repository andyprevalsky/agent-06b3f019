import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './msw/server';
import { capturedRequests, clearCaptures } from './msw/capture';
import { renderWithProviders } from './test-wrapper';
import AdminHealth from '@/pages/AdminHealth';
import { fetchAdminHealthData } from '@/features/admin-health/api';

const API_BASE = 'http://localhost:3001/api';

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
    mockSession();
    installAdminHealthHandler();
  });

  afterEach(() => {
    localStorage.clear();
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
    expect(screen.getByText('# of Users')).toBeInTheDocument();
    expect(screen.getAllByText('42').length).toBeGreaterThan(0);
    expect(screen.getByText('2 new subscribers this period.')).toBeInTheDocument();
    expect(screen.getAllByText('Avg Tasks / User / Month').length).toBeGreaterThan(0);
    expect(screen.getAllByText('3.05').length).toBeGreaterThan(0);
    expect(
      screen.getByText('128 root tasks this month / 42 subscribed users.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Tasks and Users')).not.toBeInTheDocument();
    expect(screen.getByText('Output Tokens / Task')).toBeInTheDocument();
    expect(screen.getAllByText('1,840').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Task Completion Rate').length).toBeGreaterThan(0);
    expect(screen.getAllByText('82%').length).toBeGreaterThan(0);
    expect(screen.getByText('Activation Funnel')).toBeInTheDocument();
    expect(screen.getByText('Landing page viewed')).toBeInTheDocument();
    expect(screen.getByText('Query box clicked')).toBeInTheDocument();
    expect(screen.getByText('Content typed')).toBeInTheDocument();
    expect(screen.getByText('Goal submitted')).toBeInTheDocument();
    expect(screen.getByText('Phone entered / OTP requested')).toBeInTheDocument();
    expect(screen.getByText('OTP code submitted')).toBeInTheDocument();
    expect(screen.getByText('First task created')).toBeInTheDocument();
    expect(screen.getByText('Second task created')).toBeInTheDocument();
    expect(screen.getByText('Third task created')).toBeInTheDocument();
    expect(screen.getByText('Weekly Cohort Retention Curves')).toBeInTheDocument();
    expect(screen.getByText('Linear Points Completed')).toBeInTheDocument();
    expect(screen.getByText('GitHub Commits Landed')).toBeInTheDocument();
    expect(screen.getByText('Andy Linear points completed')).toBeInTheDocument();
    expect(screen.getByText('Tamara Linear points completed')).toBeInTheDocument();
    expect(screen.getByText('GitHub commits landed')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Linear points over time' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'GitHub commits over time' })).toBeInTheDocument();
    expect(screen.getByText('End-to-end conversion')).toBeInTheDocument();
    const funnelSteps = screen.getByRole('list', { name: 'Activation funnel steps' });
    expect(within(funnelSteps).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getAllByText('Volume')).toHaveLength(10);
    expect(screen.getAllByText('Conversion')).toHaveLength(10);
    expect(screen.getAllByLabelText(/vs prior month/).length).toBeGreaterThan(10);
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

  it('reuses a fresh local cache instead of refetching the same slice', async () => {
    clearCaptures();
    await fetchAdminHealthData('weekly');
    await fetchAdminHealthData('weekly');

    const requests = capturedRequests.filter(
      (request) =>
        request.method === 'GET' && request.url.includes('/admin-health?timeSlice=weekly'),
    );
    expect(requests).toHaveLength(1);
  });
});
