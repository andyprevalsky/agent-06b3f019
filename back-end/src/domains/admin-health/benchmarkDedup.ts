import { ADMIN_USER_IDS } from './config';
import type { RootTaskRecord } from './repo';

/**
 * Historical benchmark runs predate the `isBenchmark` flag, so nothing marks them
 * in the DB. They are indistinguishable from real tasks EXCEPT that a benchmark
 * replays the same fixed goal string many times under an internal operator account.
 * Collapse identical (userId, goal) root tasks within a period for our own operator
 * accounts so that pre-flag benchmark repetition can't inflate task metrics. Real
 * customer accounts are never deduped — every task they issue counts.
 */
export function dedupeInternalRepeatTasks<T extends Pick<RootTaskRecord, 'userId' | 'goal'>>(
  tasks: T[]
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const task of tasks) {
    if (ADMIN_USER_IDS.has(task.userId)) {
      const key = `${task.userId} ${task.goal}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    deduped.push(task);
  }
  return deduped;
}
