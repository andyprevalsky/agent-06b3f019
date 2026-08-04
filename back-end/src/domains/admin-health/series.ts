import { dedupeInternalRepeatTasks } from './benchmarkDedup';
import { averageOutputTokens, taskCompletionRate, tasksIssuedPerUser } from './taskMetrics';
import { gmvPerTaskCents, sumGmvCents } from './gmvMetrics';
import type * as repo from './repo';
import type { SubscriberSeriesPoint } from './subscriberMetrics';
import { findPeriodIndex } from './time';
import type { AdminHealthPeriod, AdminHealthSeriesPoint } from './types';

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
  gmvRecords: repo.GmvRecord[] = []
): AdminHealthSeriesPoint[] {
  const tasksByPeriod = periods.map(() => [] as repo.RootTaskRecord[]);
  const waitlistSignupsByPeriod = periods.map(() => 0);
  const gmvByPeriod = periods.map(() => [] as repo.GmvRecord[]);
  for (const task of tasks) {
    const index = findPeriodIndex(periods, task.createdAt);
    if (index >= 0) tasksByPeriod[index].push(task);
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
      taskCompletionRate: taskCompletionRate(periodTasks),
    };
  });
}
