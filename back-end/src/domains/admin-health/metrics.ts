import { createLogger } from '../../providers/logger';
import { getVerifiedStripeMetricsClient } from '../../providers/stripe';
import type { AmplitudeFunnelResult, AmplitudeFunnelStepId } from './amplitude';
import { STRIPE_REVENUE_EXCLUDED_CHARGE_IDS } from './config';
import type * as repo from './repo';
import type { SubscriberSeriesPoint } from './subscriberMetrics';
import { findPeriodIndex, formatPeriodLabel, startOfWeek } from './time';
import type {
  AdminHealthFunnelStep,
  AdminHealthPeriod,
  AdminHealthResponse,
  AdminHealthRetentionCohort,
  AdminHealthSeriesPoint,
} from './types';

const log = createLogger('AdminHealth');

interface StripeRevenueCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  paid: boolean;
  status: string;
}

export function collectedStripeRevenueCents(
  charge: StripeRevenueCharge,
  excludedChargeIds: ReadonlySet<string> = STRIPE_REVENUE_EXCLUDED_CHARGE_IDS
): number {
  if (excludedChargeIds.has(charge.id)) return 0;
  if (!charge.paid || charge.status !== 'succeeded') return 0;
  return Math.max(0, charge.amount - charge.amount_refunded);
}

export async function fetchStripeRevenueByPeriod(
  periods: AdminHealthPeriod[]
): Promise<Array<{ revenueCents: number | null }>> {
  const start = new Date(periods[0].start);
  const end = new Date(periods[periods.length - 1].end);
  const buckets = periods.map(() => ({ revenueCents: 0 }));
  try {
    const stripe = await getVerifiedStripeMetricsClient();
    for await (const charge of stripe.charges.list({
      created: {
        gte: Math.floor(start.getTime() / 1000),
        lt: Math.floor(end.getTime() / 1000),
      },
      limit: 100,
    })) {
      const collectedCents = collectedStripeRevenueCents(charge);
      if (collectedCents === 0) continue;
      const index = findPeriodIndex(periods, new Date(charge.created * 1000));
      if (index < 0) continue;
      buckets[index].revenueCents += collectedCents;
    }
  } catch (error) {
    log.error('Stripe revenue fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return periods.map(() => ({ revenueCents: null }));
  }
  return buckets;
}

export function averageOutputTokens(tasks: repo.RootTaskRecord[]): number {
  if (tasks.length === 0) return 0;
  return Math.round(tasks.reduce((sum, task) => sum + task.tokensOut, 0) / tasks.length);
}

export function tasksIssuedPerUser(tasks: repo.RootTaskRecord[], userCount: number): number {
  if (userCount === 0) return 0;
  return Number((tasks.length / userCount).toFixed(4));
}

export function taskCompletionRate(tasks: repo.RootTaskRecord[]): number {
  if (tasks.length === 0) return 0;
  const completed = tasks.filter((task) => task.status === 'COMPLETED').length;
  return Number((completed / tasks.length).toFixed(4));
}

export function buildRetentionCohorts(
  firstTasks: Array<{ userId: string; firstTaskAt: Date }>,
  tasks: repo.RootTaskRecord[],
  end: Date
): AdminHealthRetentionCohort[] {
  const cohortUsers = new Map<string, Set<string>>();
  const userCohort = new Map<string, string>();
  for (const firstTask of firstTasks) {
    const cohortKey = startOfWeek(firstTask.firstTaskAt).toISOString().slice(0, 10);
    const users = cohortUsers.get(cohortKey) ?? new Set<string>();
    users.add(firstTask.userId);
    cohortUsers.set(cohortKey, users);
    userCohort.set(firstTask.userId, cohortKey);
  }
  const activity = buildCohortActivity(tasks, userCohort);
  return Array.from(cohortUsers.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohortKey, users]) => createRetentionCohort(cohortKey, users.size, activity, end))
    .slice(-8);
}

function buildCohortActivity(
  tasks: repo.RootTaskRecord[],
  userCohort: Map<string, string>
): Map<string, Set<string>> {
  const activity = new Map<string, Set<string>>();
  for (const task of tasks) {
    const cohortKey = userCohort.get(task.userId);
    if (cohortKey === undefined || cohortKey === '') continue;
    const week = Math.floor(
      (startOfWeek(task.createdAt).getTime() - Date.parse(cohortKey)) / 604_800_000
    );
    if (week < 0) continue;
    const activityKey = `${cohortKey}:${week}`;
    const retained = activity.get(activityKey) ?? new Set<string>();
    retained.add(task.userId);
    activity.set(activityKey, retained);
  }
  return activity;
}

function createRetentionCohort(
  cohortKey: string,
  size: number,
  activity: Map<string, Set<string>>,
  end: Date
): AdminHealthRetentionCohort {
  const maxWeek = Math.max(
    0,
    Math.floor((startOfWeek(end).getTime() - Date.parse(cohortKey)) / 604_800_000)
  );
  const points = Array.from({ length: Math.min(maxWeek + 1, 12) }, (_, week) => {
    const retainedUsers = activity.get(`${cohortKey}:${week}`)?.size ?? 0;
    return {
      week,
      retainedUsers,
      retentionRate: size > 0 ? Number((retainedUsers / size).toFixed(4)) : 0,
    };
  });
  return {
    cohortWeek: cohortKey,
    label: formatPeriodLabel(new Date(`${cohortKey}T00:00:00.000Z`), 'weekly'),
    size,
    points,
  };
}

function funnelStep(
  id: string,
  label: string,
  count: number | null,
  source: AdminHealthFunnelStep['source'],
  detail?: string
): AdminHealthFunnelStep {
  return {
    id,
    label,
    count,
    previousCount: null,
    conversionRate: null,
    previousConversionRate: null,
    conversionRateChange: null,
    source,
    status: count === null ? 'unavailable' : 'ready',
    ...(detail === undefined ? {} : { detail }),
  };
}

function countUsersAtTaskDepth(tasks: repo.RootTaskRecord[], taskDepth: number): number {
  const countsByUser = new Map<string, number>();
  for (const task of tasks) {
    countsByUser.set(task.userId, (countsByUser.get(task.userId) ?? 0) + 1);
  }
  return Array.from(countsByUser.values()).filter((count) => count >= taskDepth).length;
}

export function buildFunnelSteps(
  tasks: repo.RootTaskRecord[],
  signedUpUsers: number,
  amplitude: AmplitudeFunnelResult
): AdminHealthFunnelStep[] {
  const client = (id: AmplitudeFunnelStepId, label: string) =>
    funnelStep(id, label, amplitude.counts[id], 'client_analytics', amplitude.detail);
  return [
    client('landing_page_viewed', 'Landing page viewed'),
    client('querybox_clicked', 'Query box clicked'),
    client('content_typed', 'Content typed'),
    client('goal_submitted', 'Goal submitted'),
    client('phone_entered', 'Phone entered / OTP requested'),
    client('otp_code_submitted', 'OTP code submitted'),
    funnelStep(
      'account_created',
      'Account created',
      signedUpUsers,
      'database',
      'New registered accounts in the selected period; this is not subscriber count.'
    ),
    funnelStep(
      'first_task_created',
      'First task created',
      countUsersAtTaskDepth(tasks, 1),
      'database',
      'New-account cohort users who issued at least one task.'
    ),
    funnelStep(
      'second_task_created',
      'Second task created',
      countUsersAtTaskDepth(tasks, 2),
      'database',
      'New-account cohort users who issued at least two tasks.'
    ),
    funnelStep(
      'third_task_created',
      'Third task created',
      countUsersAtTaskDepth(tasks, 3),
      'database',
      'New-account cohort users who issued at least three tasks.'
    ),
  ];
}

function conversionRate(steps: AdminHealthFunnelStep[], index: number): number | null {
  const count = steps[index]?.count;
  if (count === null || count === undefined) return null;
  if (index === 0 || steps[index - 1]?.source !== steps[index]?.source) return 1;
  const priorCount = steps[index - 1]?.count;
  if (priorCount === null || priorCount === undefined || priorCount === 0) return null;
  if (count > priorCount) return null;
  return Number((count / priorCount).toFixed(4));
}

function relativeChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Number(((current - previous) / previous).toFixed(4));
}

function finalGroupEndToEndRate(steps: AdminHealthFunnelStep[]): number | null {
  const source = steps.at(-1)?.source;
  const group = steps.filter((step) => step.source === source);
  const first = group[0]?.count;
  const last = group.at(-1)?.count;
  if (first === null || first === undefined || first === 0 || last === null || last === undefined) {
    return null;
  }
  return Number((last / first).toFixed(4));
}

export function compareFunnelSteps(
  current: AdminHealthFunnelStep[],
  previous: AdminHealthFunnelStep[]
): AdminHealthResponse['funnel'] {
  const steps = current.map((step, index) => {
    const currentRate = conversionRate(current, index);
    const previousRate = conversionRate(previous, index);
    return {
      ...step,
      previousCount: previous[index]?.count ?? null,
      conversionRate: currentRate,
      previousConversionRate: previousRate,
      conversionRateChange: relativeChange(currentRate, previousRate),
    };
  });
  const currentEndToEnd = finalGroupEndToEndRate(current);
  const previousEndToEnd = finalGroupEndToEndRate(previous);
  return {
    steps,
    endToEnd: {
      conversionRate: currentEndToEnd,
      previousConversionRate: previousEndToEnd,
      conversionRateChange: relativeChange(currentEndToEnd, previousEndToEnd),
    },
  };
}

export function buildSeries(
  periods: AdminHealthPeriod[],
  tasks: repo.RootTaskRecord[],
  waitlistSignups: repo.WaitlistSignupRecord[],
  subscribers: SubscriberSeriesPoint[],
  revenue: Array<{ revenueCents: number | null }>,
  velocity: Array<{
    andyLinearPoints: number | null;
    githubCommits: number | null;
    tamaraLinearPoints: number | null;
  }>
): AdminHealthSeriesPoint[] {
  const tasksByPeriod = periods.map(() => [] as repo.RootTaskRecord[]);
  const waitlistSignupsByPeriod = periods.map(() => 0);
  for (const task of tasks) {
    const index = findPeriodIndex(periods, task.createdAt);
    if (index >= 0) tasksByPeriod[index].push(task);
  }
  for (const signup of waitlistSignups) {
    const index = findPeriodIndex(periods, signup.createdAt);
    if (index >= 0) waitlistSignupsByPeriod[index] += 1;
  }
  const emptySubscriber: SubscriberSeriesPoint = { userCount: 0, newUsers: 0, userIds: new Set() };
  return periods.map((period, index) => {
    const subscriberPoint = subscribers[index] ?? emptySubscriber;
    const periodTasks = tasksByPeriod[index].filter((task) =>
      subscriberPoint.userIds.has(task.userId)
    );
    return {
      ...period,
      ...revenue[index],
      ...velocity[index],
      waitlistSignups: waitlistSignupsByPeriod[index],
      userCount: subscriberPoint.userCount,
      newUsers: subscriberPoint.newUsers,
      taskCount: periodTasks.length,
      tasksIssuedPerUser: tasksIssuedPerUser(periodTasks, subscriberPoint.userCount),
      outputTokensPerTask: averageOutputTokens(periodTasks),
      taskCompletionRate: taskCompletionRate(periodTasks),
    };
  });
}
