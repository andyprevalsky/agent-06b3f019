import {
  WorkflowClient,
  type Client,
  type ListOptions,
  type WorkflowExecutionInfo,
} from '@temporalio/client';
import { prisma } from '../src/providers/database';
import {
  acquireWorkflowDeploymentLease,
  type WorkflowDeploymentLease,
} from '../src/providers/workflowDeploymentLease';

/**
 * Run-scoped isolation for `validate-prod-workflow-migration.ts` (the /deploy
 * `workflow-migration` lane).
 *
 * The validator used to hold the single production cutover lease
 * (`deployment:temporal-workflow-cutover`) for its whole ~6 min run, so every
 * owner's lane in a batched merge wave, and every real Fly cutover, waited on
 * it (#2086 timed out three times at 600 s). Every fixture the validator
 * creates is already isolated by its run-unique user, queue, and agent IDs; the
 * pieces below isolate the remaining shared surfaces instead of serializing:
 *
 * - admission: a liveness lease keyed by the run's own ID, which no other run
 *   or cutover ever contends for;
 * - fleet stuck-state reads: another run's fixtures are excluded only while
 *   that run's lease is live, so a crashed run's leftovers still fail;
 * - activation-marker retirement: the production cleanup runs through a client
 *   whose visibility listing yields only this run's markers and whose identity
 *   attributes every termination it makes to this run.
 */

export const VALIDATION_RUN_OPERATION_TYPE = 'PROD_WORKFLOW_MIGRATION_VALIDATION_RUN';
export const VALIDATION_USER_PREFIX = 'prod-workflow-migration-validation-';
const VALIDATION_RUN_KEY_PREFIX = 'deployment:workflow-migration-validation:';

export function validationRunLeaseKey(runId: string): string {
  return `${VALIDATION_RUN_KEY_PREFIX}${runId}`;
}

export function validationUserId(runId: string): string {
  return `${VALIDATION_USER_PREFIX}${runId}`;
}

/** Admit one validation run without waiting on any other run or on a cutover. */
export async function beginValidationRun(
  runId: string,
  options: { leaseMs?: number; heartbeatMs?: number } = {}
): Promise<WorkflowDeploymentLease> {
  return acquireWorkflowDeploymentLease({
    ...options,
    operationKey: validationRunLeaseKey(runId),
    operationType: VALIDATION_RUN_OPERATION_TYPE,
  });
}

/** Release the run's liveness lease and remove its row. */
export async function endValidationRun(
  runId: string,
  lease: WorkflowDeploymentLease
): Promise<void> {
  await lease.release();
  await prisma.toolSideEffect.deleteMany({
    where: {
      operationKey: validationRunLeaseKey(runId),
      operationType: VALIDATION_RUN_OPERATION_TYPE,
      externalId: lease.ownerId,
    },
  });
}

/**
 * The subset of `candidateUserIds` that belong to another validation run whose
 * liveness lease is still current. A run that ended or crashed (lease released,
 * deleted, or expired) is not live, so its leftover fixtures stay visible.
 */
export async function liveConcurrentValidationUserIds(
  candidateUserIds: Iterable<string>,
  ownRunId: string
): Promise<string[]> {
  const userByKey = new Map<string, string>();
  for (const userId of candidateUserIds) {
    if (!userId.startsWith(VALIDATION_USER_PREFIX)) continue;
    const runId = userId.slice(VALIDATION_USER_PREFIX.length);
    if (runId.length === 0 || runId === ownRunId) continue;
    userByKey.set(validationRunLeaseKey(runId), userId);
  }
  if (userByKey.size === 0) return [];
  const rows = await prisma.toolSideEffect.findMany({
    where: {
      operationKey: { in: [...userByKey.keys()] },
      operationType: VALIDATION_RUN_OPERATION_TYPE,
      status: 'STARTED',
    },
    select: { operationKey: true, updatedAt: true, request: true },
  });
  const now = (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]
    .now;
  return rows.flatMap((row) => {
    const leaseMs = (row.request as { leaseMs?: unknown } | null)?.leaseMs;
    const userId = userByKey.get(row.operationKey);
    const live =
      typeof leaseMs === 'number' &&
      Number.isFinite(leaseMs) &&
      leaseMs > 0 &&
      row.updatedAt.getTime() + leaseMs > now.getTime();
    return live && userId !== undefined ? [userId] : [];
  });
}

class RunScopedWorkflowClient extends WorkflowClient {
  private readonly scopedWorkflowIds: ReadonlySet<string>;

  constructor(
    options: ConstructorParameters<typeof WorkflowClient>[0],
    scopedWorkflowIds: ReadonlySet<string>
  ) {
    super(options);
    this.scopedWorkflowIds = scopedWorkflowIds;
  }

  protected override async *_list(options?: ListOptions): AsyncIterable<WorkflowExecutionInfo> {
    for await (const execution of super._list(options)) {
      if (this.scopedWorkflowIds.has(execution.workflowId)) yield execution;
    }
  }
}

/**
 * A client for the production marker cleanup that sees only `workflowIds` in
 * visibility listings and stamps `identity` on every request it makes.
 */
export function runScopedTemporalClient(
  base: Pick<Client, 'connection' | 'options'>,
  workflowIds: Iterable<string>,
  identity: string
): Pick<Client, 'withDeadline' | 'workflow'> {
  const workflow = new RunScopedWorkflowClient(
    {
      connection: base.connection,
      namespace: base.options.namespace,
      dataConverter: base.options.loadedDataConverter,
      identity,
    },
    new Set(workflowIds)
  );
  return { withDeadline: (deadline, fn) => workflow.withDeadline(deadline, fn), workflow };
}

/** Identity recorded on a workflow's termination event, or null if it was not terminated. */
export function terminatorIdentity(
  events:
    | ReadonlyArray<{
        workflowExecutionTerminatedEventAttributes?: { identity?: string | null } | null;
      }>
    | null
    | undefined
): string | null {
  for (const event of events ?? []) {
    const attributes = event.workflowExecutionTerminatedEventAttributes;
    if (attributes != null) return attributes.identity ?? '';
  }
  return null;
}

/**
 * Run a time-window observation of one workflow generation. Retry on a fresh
 * generation only when the run ID changed during the failed attempt: a
 * concurrent cooperative cutover handed the parked workflow off with
 * continue-as-new, so the window straddled two histories. Any failure within
 * one generation is rethrown unchanged.
 */
export async function observeSingleGeneration<T>(
  readRunId: () => Promise<string>,
  observe: () => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    const before = await readRunId();
    try {
      return await observe();
    } catch (error) {
      if (attempt >= maxAttempts || (await readRunId()) === before) throw error;
    }
  }
}
