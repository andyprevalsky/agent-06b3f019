import type { RootTaskRecord } from './repo';

export function averageOutputTokens(tasks: RootTaskRecord[]): number {
  if (tasks.length === 0) return 0;
  return Math.round(tasks.reduce((sum, task) => sum + task.tokensOut, 0) / tasks.length);
}

export function tasksIssuedPerUser(tasks: RootTaskRecord[], userCount: number): number {
  if (userCount === 0) return 0;
  return Number((tasks.length / userCount).toFixed(4));
}

export function taskCompletionRate(tasks: RootTaskRecord[]): number {
  if (tasks.length === 0) return 0;
  const completed = tasks.filter((task) => task.status === 'COMPLETED').length;
  return Number((completed / tasks.length).toFixed(4));
}
