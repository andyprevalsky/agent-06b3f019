import type * as repo from './repo';

export function sumGmvCents(records: repo.GmvRecord[]): number {
  return records.reduce((sum, record) => sum + record.totalCents, 0);
}

/** Average facilitated + AgentCard GMV per root task, in cents. */
export function gmvPerTaskCents(gmvCents: number, taskCount: number): number {
  if (taskCount === 0) return 0;
  return Math.round(gmvCents / taskCount);
}
