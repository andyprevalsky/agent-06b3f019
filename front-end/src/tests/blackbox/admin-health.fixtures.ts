/**
 * Payload fixtures for the AdminHealth blackbox suite.
 *
 * Extracted from the suite itself to keep that file within its line budget;
 * mirrors the existing plaid.fixtures convention.
 */

export function makeSeries() {
  return Array.from({ length: 12 }, (_, index) => ({
    key: `2026-0${(index % 9) + 1}-01`,
    label: `W${index + 1}`,
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-01-08T00:00:00.000Z',
    revenueCents: 10000 + index * 1000,
    gmvCents: 5000 + index * 500,
    waitlistSignups: 3 + index,
    userCount: 20 + index,
    newUsers: 2,
    taskCount: 10 + index,
    tasksIssuedPerUser: 0.8 + index / 10,
    outputTokensPerTask: 1200 + index * 80,
    gmvPerTask: 400 + index * 25,
    taskCompletionRate: 0.7 + index / 100,
    costPerTask: {
      zeroLlmCostDollars: 0.02 + index / 1_000,
      apiRateDollars: 0.5 + index / 100,
      computeTokenRateDollars: 0.044 + index / 1_000,
      sampleSize: 20 + index,
    },
    andyLinearPoints: 3 + index,
    githubCommits: 12 + index,
    tamaraLinearPoints: 2 + index,
  }));
}

export function makeFunnelSteps() {
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

export function adminHealthPayload(timeSlice = 'monthly') {
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
      gmvCents: 25600,
      waitlistSignups: 14,
      userCount: 42,
      taskCount: 128,
      tasksIssuedPerUser: 3.05,
      outputTokensPerTask: 1840,
      gmvPerTask: 200,
      taskCompletionRate: 0.82,
      costPerTask: {
        zeroLlmCostDollars: 0.0384,
        apiRateDollars: 0.7594,
        computeTokenRateDollars: 0.0745,
        sampleSize: 332,
      },
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
    connectorAdoption: {
      eligibleUserCount: 24,
      subtypes: [
        { id: 'browsers', label: 'Browser Sync', connectedUsers: 12, connectionRate: 0.5 },
        { id: 'passwords', label: 'Passwords', connectedUsers: 9, connectionRate: 0.375 },
        { id: 'compute', label: 'Compute', connectedUsers: 18, connectionRate: 0.75 },
        { id: 'messages', label: 'Messages', connectedUsers: 15, connectionRate: 0.625 },
        { id: 'socials', label: 'Socials', connectedUsers: 6, connectionRate: 0.25 },
        { id: 'financials', label: 'Financials', connectedUsers: 3, connectionRate: 0.125 },
      ],
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
