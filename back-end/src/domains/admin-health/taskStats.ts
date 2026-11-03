import type { RootTaskRecord } from './repo';

export function averageOutputTokens(tasks: RootTaskRecord[]): number {
  if (tasks.length === 0) return 0;
  return Math.round(tasks.reduce((sum, task) => sum + task.tokensOut, 0) / tasks.length);
}

export function tasksIssuedPerUser(tasks: RootTaskRecord[], userCount: number): number {
  if (userCount === 0) return 0;
  return Number((tasks.length / userCount).toFixed(4));
}

const UNRESOLVED_STATUSES: ReadonlySet<RootTaskRecord['status']> = new Set([
  'STARTING_UP',
  'ACTIVE',
  'PAUSED',
]);

type OutcomeTask = Pick<RootTaskRecord, 'status'> & { archivedBeforeOutcome?: boolean };

/** Has an outcome: not still running, and not archived before it finished. */
export function isResolvedTask(task: OutcomeTask): boolean {
  return !UNRESOLVED_STATUSES.has(task.status) && task.archivedBeforeOutcome !== true;
}

/**
 * Completed / resolved root tasks. Tasks still running (or archived while
 * running) have no outcome, so counting them as failures dragged every period
 * down. Null (not 0%) when nothing resolved: no evidence is not 0% success.
 */
export function taskCompletionRate(tasks: OutcomeTask[]): number | null {
  const resolved = tasks.filter(isResolvedTask);
  if (resolved.length === 0) return null;
  const completed = resolved.filter((task) => task.status === 'COMPLETED').length;
  return Number((completed / resolved.length).toFixed(4));
}
