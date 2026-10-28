import { z } from 'zod';
import { retryWithBackoff } from '../../providers/retry';

export interface ConnectorAdoptionResponse {
  eligibleUserCount: number;
  subtypes: Array<{
    id: string;
    label: string;
    connectedUsers: number;
    connectionRate: number;
  }>;
}

export function assertConnectorAdoption(value: unknown): asserts value is {
  connectorAdoption: ConnectorAdoptionResponse;
} {
  if (value === null || typeof value !== 'object' || !('connectorAdoption' in value)) {
    throw new Error('Admin health response is missing connectorAdoption');
  }
  const adoption = (value as { connectorAdoption?: unknown }).connectorAdoption;
  if (adoption === null || typeof adoption !== 'object') {
    throw new Error('connectorAdoption must be an object');
  }
  const candidate = adoption as Partial<ConnectorAdoptionResponse>;
  if (!Number.isInteger(candidate.eligibleUserCount) || (candidate.eligibleUserCount ?? -1) < 0) {
    throw new Error('connectorAdoption.eligibleUserCount must be a non-negative integer');
  }
  if (!Array.isArray(candidate.subtypes)) {
    throw new Error('connectorAdoption.subtypes must be an array');
  }
  const expectedIds = ['browsers', 'passwords', 'compute', 'messages', 'socials', 'financials'];
  if (candidate.subtypes.map((subtype) => subtype.id).join(',') !== expectedIds.join(',')) {
    throw new Error('connectorAdoption must include every onboarding connector subtype in order');
  }
  for (const subtype of candidate.subtypes) {
    if (!Number.isInteger(subtype.connectedUsers) || subtype.connectedUsers < 0) {
      throw new Error(`${subtype.id}.connectedUsers must be a non-negative integer`);
    }
    if (subtype.connectedUsers > (candidate.eligibleUserCount ?? 0)) {
      throw new Error(`${subtype.id}.connectedUsers cannot exceed the eligible population`);
    }
    if (subtype.connectionRate < 0 || subtype.connectionRate > 1) {
      throw new Error(`${subtype.id}.connectionRate must be between zero and one`);
    }
    const expectedRate =
      candidate.eligibleUserCount === 0
        ? 0
        : Number((subtype.connectedUsers / candidate.eligibleUserCount).toFixed(4));
    if (subtype.connectionRate !== expectedRate) {
      throw new Error(`${subtype.id}.connectionRate does not match its user counts`);
    }
  }
}

/** Structural slice of AdminHealthResponse needed for activation-count checks. */
export interface ActivationCheckBody {
  generatedAt: string;
  range: { start: string; end: string };
  funnel: { steps: Array<{ source: string; count: number | null }> };
}

export async function computeExpectedActivationCounts(
  body: ActivationCheckBody
): Promise<number[]> {
  const { ADMIN_USER_IDS } = await import('../../domains/admin-health/config');
  const { findRootTasksBetween, findVerifiedUsersCreatedBefore } =
    await import('../../domains/admin-health/repo');
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
 * A response served from the admin-health per-UTC-day in-process cache (primed
 * before recent test-created users existed — re-running the suite against a
 * warm backend does this) can never converge: refetches return the same pinned
 * snapshot while the live DB keeps moving. generatedAt is the snapshot's
 * retrieval time, so a stale generatedAt identifies that case exactly — skip
 * instead of burning retries; fresh-backend runs still assert strictly.
 */
export async function assertDatabaseActivationCounts(
  body: ActivationCheckBody,
  refetch: () => Promise<ActivationCheckBody>
): Promise<void> {
  if (Date.now() - new Date(body.generatedAt).getTime() > 60_000) {
    console.log('    [info] day-cached admin-health snapshot — skipping exact activation match');
    return;
  }
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

// ---------------------------------------------------------------------------
// Response schemas for GET /api/admin-health
// ---------------------------------------------------------------------------

export const MetricStatusSchema = z.union([
  z.literal('ready'),
  z.literal('unavailable'),
  z.literal('error'),
]);
export const VelocityMetricSchema = z.object({
  label: z.string(),
  value: z.number().nullable(),
  status: MetricStatusSchema,
  detail: z.string().optional(),
});
export const TaskCostPerTaskSchema = z.object({
  zeroLlmCostDollars: z.number().nonnegative().nullable(),
  apiRateDollars: z.number().nonnegative().nullable(),
  computeTokenRateDollars: z.number().nonnegative().nullable(),
  sampleSize: z.number().int().nonnegative(),
});
export const AdminHealthResponseSchema = z.object({
  timeSlice: z.union([
    z.literal('weekly'),
    z.literal('monthly'),
    z.literal('quarterly'),
    z.literal('yearly'),
  ]),
  generatedAt: z.string(),
  range: z.object({ start: z.string(), end: z.string() }),
  historyRange: z.object({ start: z.string(), end: z.string() }),
  summary: z.object({
    revenueCents: z.number().nullable(),
    gmvCents: z.number(),
    userCount: z.number(),
    taskCount: z.number(),
    tasksIssuedPerUser: z.number(),
    outputTokensPerTask: z.number(),
    gmvPerTask: z.number(),
    taskCompletionRate: z.number().nullable(),
    costPerTask: TaskCostPerTaskSchema,
  }),
  series: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      start: z.string(),
      end: z.string(),
      revenueCents: z.number().nullable(),
      gmvCents: z.number(),
      userCount: z.number(),
      newUsers: z.number(),
      taskCount: z.number(),
      tasksIssuedPerUser: z.number(),
      outputTokensPerTask: z.number(),
      gmvPerTask: z.number(),
      taskCompletionRate: z.number().nullable(),
      costPerTask: TaskCostPerTaskSchema,
      andyLinearPoints: z.number().nullable(),
      githubCommits: z.number().nullable(),
      tamaraLinearPoints: z.number().nullable(),
    })
  ),
  retentionCohorts: z.array(
    z.object({
      cohortWeek: z.string(),
      label: z.string(),
      size: z.number(),
      points: z.array(
        z.object({
          week: z.number(),
          retainedUsers: z.number(),
          retentionRate: z.number(),
        })
      ),
    })
  ),
  funnel: z.object({
    steps: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        count: z.number().nullable(),
        previousCount: z.number().nullable(),
        conversionRate: z.number().nullable(),
        previousConversionRate: z.number().nullable(),
        conversionRateChange: z.number().nullable(),
        source: z.union([z.literal('database'), z.literal('client_analytics')]),
        status: z.union([z.literal('ready'), z.literal('unavailable')]),
        detail: z.string().optional(),
      })
    ),
    endToEnd: z.object({
      conversionRate: z.number().nullable(),
      previousConversionRate: z.number().nullable(),
      conversionRateChange: z.number().nullable(),
    }),
  }),
  velocity: z.object({
    dev: z.object({
      linearPointsCompleted: VelocityMetricSchema,
      githubCommitsLanded: VelocityMetricSchema,
    }),
    ops: z.object({
      linearPointsCompleted: VelocityMetricSchema,
    }),
  }),
});
export const ErrorResponseSchema = z.object({ error: z.string() });
export type AdminHealthResponse = z.infer<typeof AdminHealthResponseSchema>;
