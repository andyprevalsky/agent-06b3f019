import { dedupeInternalRepeatTasks } from './benchmarkDedup';
import { calculateTaskCostPerTask } from './costs';
import type * as repo from './repo';
import type { SubscriberSeriesPoint } from './subscriberMetrics';
import { averageOutputTokens, taskCompletionRate, tasksIssuedPerUser } from './taskStats';
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
  rootAgentRuns: RootAgentRunRecord[] = [],
  rootAgentRunUsage: RootAgentRunUsageRecord[] = []
): AdminHealthSeriesPoint[] {
  const tasksByPeriod = periods.map(() => [] as repo.RootTaskRecord[]);
  const rootAgentRunsByPeriod = periods.map(() => [] as RootAgentRunRecord[]);
  const waitlistSignupsByPeriod = periods.map(() => 0);
  for (const task of tasks) {
    const index = findPeriodIndex(periods, task.createdAt);
    if (index >= 0) tasksByPeriod[index].push(task);
  }
  for (const run of rootAgentRuns) {
    const index = findPeriodIndex(periods, run.createdAt);
    if (index >= 0) rootAgentRunsByPeriod[index].push(run);
  }
  for (const signup of waitlistSignups) {
    const index = findPeriodIndex(periods, signup.createdAt);
    if (index >= 0) waitlistSignupsByPeriod[index] += 1;
  }
  const emptySubscriber: SubscriberSeriesPoint = { userCount: 0, newUsers: 0, userIds: new Set() };
  return periods.map((period, index) => {
    const subscriberPoint = subscribers[index] ?? emptySubscriber;
    const periodTasks = dedupeInternalRepeatTasks(
      tasksByPeriod[index].filter((task) => subscriberPoint.userIds.has(task.userId))
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
      costPerTask: calculateTaskCostPerTask(rootAgentRunsByPeriod[index], rootAgentRunUsage),
    };
  });
}
