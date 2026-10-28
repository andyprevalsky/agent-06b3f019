import { dedupeInternalRepeatTasks } from './benchmarkDedup';
import { calculateTaskCostPerTask } from './costs';
import { gmvPerTaskCents, sumGmvCents } from './gmvMetrics';
import type * as repo from './repo';
import type { ProductRootTaskRecord } from './repoProductUsage';
import type { SubscriberSeriesPoint } from './subscriberMetrics';
import {
  averageOutputTokens,
  isResolvedTask,
  taskCompletionRate,
  tasksIssuedPerUser,
} from './taskStats';
import { findPeriodIndex } from './time';
import type {
  AdminHealthPeriod,
  AdminHealthSeriesPoint,
  RootAgentRunRecord,
  RootAgentRunUsageRecord,
} from './types';

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
  }>,
  productTasks: ProductRootTaskRecord[],
  gmvRecords: repo.GmvRecord[] = [],
  rootAgentRuns: RootAgentRunRecord[] = [],
  rootAgentRunUsage: RootAgentRunUsageRecord[] = []
): AdminHealthSeriesPoint[] {
  const tasksByPeriod = periods.map(() => [] as repo.RootTaskRecord[]);
  const productTasksByPeriod = periods.map(() => [] as ProductRootTaskRecord[]);
  const rootAgentRunsByPeriod = periods.map(() => [] as RootAgentRunRecord[]);
  const waitlistSignupsByPeriod = periods.map(() => 0);
  const gmvByPeriod = periods.map(() => [] as repo.GmvRecord[]);
  for (const task of tasks) {
    const index = findPeriodIndex(periods, task.createdAt);
    if (index >= 0) tasksByPeriod[index].push(task);
  }
  for (const task of productTasks) {
    const index = findPeriodIndex(periods, task.createdAt);
    if (index >= 0) productTasksByPeriod[index].push(task);
  }
  for (const run of rootAgentRuns) {
    const index = findPeriodIndex(periods, run.createdAt);
    if (index >= 0) rootAgentRunsByPeriod[index].push(run);
  }
  for (const signup of waitlistSignups) {
    const index = findPeriodIndex(periods, signup.createdAt);
    if (index >= 0) waitlistSignupsByPeriod[index] += 1;
  }
  for (const record of gmvRecords) {
    const index = findPeriodIndex(periods, record.createdAt);
    if (index >= 0) gmvByPeriod[index].push(record);
  }
  const emptySubscriber: SubscriberSeriesPoint = { userCount: 0, newUsers: 0, userIds: new Set() };
  return periods.map((period, index) => {
    const subscriberPoint = subscribers[index] ?? emptySubscriber;
    const periodTasks = dedupeInternalRepeatTasks(
      tasksByPeriod[index].filter((task) => subscriberPoint.userIds.has(task.userId))
    );
    // Platform GMV is total facilitated commerce (not cohort-filtered): AgentCard
    // clearances + structured-output order confirmations. Per-task efficiency uses
    // the same subscriber task denominator as outputTokensPerTask.
    const gmvCents = sumGmvCents(gmvByPeriod[index]);
    return {
      ...period,
      ...revenue[index],
      ...velocity[index],
      gmvCents,
      waitlistSignups: waitlistSignupsByPeriod[index],
      userCount: subscriberPoint.userCount,
      newUsers: subscriberPoint.newUsers,
      taskCount: periodTasks.length,
      tasksIssuedPerUser: tasksIssuedPerUser(periodTasks, subscriberPoint.userCount),
      outputTokensPerTask: averageOutputTokens(periodTasks),
      gmvPerTask: gmvPerTaskCents(gmvCents, periodTasks.length),
      taskCompletionRate: taskCompletionRate(latestResolvedAttempts(productTasksByPeriod[index])),
      costPerTask: calculateTaskCostPerTask(rootAgentRunsByPeriod[index], rootAgentRunUsage),
    };
  });
}

/**
 * An operator retrying the same goal is one task: keep its latest resolved
 * attempt so repeated test prompts neither inflate nor dilute the rate.
 * Customer tasks are never collapsed (see dedupeInternalRepeatTasks).
 */
function latestResolvedAttempts(tasks: ProductRootTaskRecord[]): ProductRootTaskRecord[] {
  const newestFirst = tasks
    .filter(isResolvedTask)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return dedupeInternalRepeatTasks(newestFirst);
}
