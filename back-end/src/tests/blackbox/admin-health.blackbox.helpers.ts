import { retryWithBackoff } from '../../providers/retry';

/** Structural slice of AdminHealthResponse needed for activation-count checks. */
export interface ActivationCheckBody {
  range: { start: string; end: string };
  funnel: { steps: Array<{ source: string; count: number | null }> };
}

export async function computeExpectedActivationCounts(
  body: ActivationCheckBody
): Promise<number[]> {
  const { ADMIN_USER_IDS } = await import('../../domains/admin-health/config');
  const { findRootTasksBetween, findVerifiedUsersCreatedBefore } = await import(
    '../../domains/admin-health/repo'
  );
  const users = await findVerifiedUsersCreatedBefore(
    new Date(body.range.end),
    Array.from(ADMIN_USER_IDS)
  );
  const cohortIds = new Set(
    users.filter((user) => user.createdAt >= new Date(body.range.start)).map((user) => user.userId)
  );
  const tasks = (
    await findRootTasksBetween(new Date(body.range.start), new Date(body.range.end))
  ).filter((task) => cohortIds.has(task.userId));
  const taskCountByUser = new Map<string, number>();
  for (const task of tasks) {
    taskCountByUser.set(task.userId, (taskCountByUser.get(task.userId) ?? 0) + 1);
  }
  return [
    cohortIds.size,
    Array.from(taskCountByUser.values()).filter((count) => count >= 1).length,
    Array.from(taskCountByUser.values()).filter((count) => count >= 2).length,
    Array.from(taskCountByUser.values()).filter((count) => count >= 3).length,
  ];
}

/**
 * Assert the endpoint's database-funnel counts match a direct DB recompute.
 *
 * Sibling cases run concurrently (caseConcurrency) and create verified users,
 * so the DB can move between the endpoint snapshot and the direct query. That
 * skew is test-harness concurrency, not an endpoint bug — retry the
 * (fetch, recompute) pair until both snapshots land on a quiet window.
 *
 * If `actual` stays pinned across retries while `expected` keeps moving, the
 * response is being served from the admin-health per-UTC-day in-process cache
 * primed before recent test-created users existed (re-running the suite
 * against a warm backend does this). A fresh backend process resolves it.
 */
export async function assertDatabaseActivationCounts(
  body: ActivationCheckBody,
  refetch: () => Promise<ActivationCheckBody>
): Promise<void> {
  let current = body;
  await retryWithBackoff(
    async () => {
      const expected = await computeExpectedActivationCounts(current);
      const actual = current.funnel.steps
        .filter((step) => step.source === 'database')
        .map((step) => step.count);
      if (JSON.stringify(actual) === JSON.stringify(expected)) return;
      current = await refetch();
      throw new Error(
        `Database activation must match verified new-account task depth: ` +
          `expected ${expected.join(',')}, got ${actual.join(',')} ` +
          `(a pinned "got" across retries = stale per-day admin-health cache from a warm backend)`
      );
    },
    { maxRetries: 5, initialBackoffMs: 500, isRetryable: () => true, component: 'AdminHealthRAW' }
  );
}
