import { randomUUID } from 'node:crypto';
import { Prisma, type AgentStatus } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import { prisma, runTransactionWithRetry } from './database';
import {
  captureInProgressWorkflowTools,
  finalizeInterruptedWorkflowTools,
  type ToolProgressCandidate,
} from './staleWorkflowTools';
import {
  claimTemporalWorkflowIdForTermination,
  resolveTemporalWorkflowExecutionRef,
  type TemporalWorkflowExecutionRef,
} from './temporal';
import { terminateStaleTemporalWorkflow } from './workflowReplacement';
import {
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  lockAgentWorkflowGeneration,
  StaleParentWorkflowGenerationError,
} from './workflowGeneration';

export const DESCENDANT_WORKFLOW_START_LEASE_MS = 60_000;

export interface DescendantWorkflowStartIdentity {
  agentId: string;
  parentAgentId: string;
  parentWorkflowId: string;
}

export type DescendantWorkflowStartClaim =
  | { outcome: 'claimed'; deadlineAtMs: number }
  | { outcome: 'leased'; retryAfterMs: number }
  | { outcome: 'stale' }
  | { outcome: 'settled' };

export type DescendantWorkflowStartFinalization =
  | { outcome: 'accepted' }
  | { outcome: 'terminal' }
  | { outcome: 'stale'; sealedWorkflowId: string };

type PendingDescendantWorkflowStartSeal =
  | { outcome: 'sealed'; workflowGeneration: string }
  | { outcome: 'current' }
  | { outcome: 'settled' };

export interface DescendantWorkflowStartState {
  temporalWorkflowId: string | null;
  temporalFirstExecutionRunId: string | null;
  temporalWorkflowStartPending: boolean;
  status: AgentStatus;
}

interface PendingDescendantWorkflowStartRow {
  id: string;
  parentAgentId: string;
  parentWorkflowId: string;
  temporalWorkflowId: string | null;
  staleTemporalWorkflowId: string | null;
  staleTemporalFirstExecutionRunId: string | null;
  temporalWorkflowStartLeaseUntil: Date | null;
  status: AgentStatus;
}

export interface PendingDescendantWorkflowStartDrainDependencies {
  resolveExecution: (workflowId: string) => Promise<TemporalWorkflowExecutionRef>;
  claimExecutionForTermination: (workflowId: string) => Promise<TemporalWorkflowExecutionRef>;
  terminate: (execution: TemporalWorkflowExecutionRef, agentId: string) => Promise<void>;
  captureInProgressTools: (
    agentId: string,
    workflowGeneration: string
  ) => Promise<ToolProgressCandidate[]>;
  finalizeInterruptedTools: (
    agentId: string,
    workflowGeneration: string,
    snapshot: ToolProgressCandidate[]
  ) => Promise<unknown>;
}

export interface PendingDescendantWorkflowStartDrainOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxConcurrency?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

function terminalStatus(status: AgentStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED';
}

function assertIdentity(
  row: {
    parentAgentId: string | null;
    parentWorkflowId: string | null;
  },
  identity: DescendantWorkflowStartIdentity
): void {
  if (
    row.parentAgentId !== identity.parentAgentId ||
    row.parentWorkflowId !== identity.parentWorkflowId
  ) {
    throw new StaleParentWorkflowGenerationError();
  }
}

/**
 * Claim the sole bounded right to call Temporal.start for one durable child
 * outbox row. The parent generation lock makes claim-before-seal and
 * seal-before-claim deterministic.
 */
export async function claimDescendantWorkflowStart(
  identity: DescendantWorkflowStartIdentity,
  nowMs = Date.now(),
  leaseMs = DESCENDANT_WORKFLOW_START_LEASE_MS
): Promise<DescendantWorkflowStartClaim> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, identity.parentAgentId);
    await lockAgentWorkflowGeneration(tx, identity.agentId);
    const [parent, child] = await Promise.all([
      tx.agent.findUnique({
        where: { id: identity.parentAgentId },
        select: { temporalWorkflowId: true, deletedAt: true, status: true },
      }),
      tx.agent.findUnique({
        where: { id: identity.agentId },
        select: {
          parentAgentId: true,
          parentWorkflowId: true,
          temporalWorkflowId: true,
          temporalFirstExecutionRunId: true,
          temporalWorkflowStartPending: true,
          temporalWorkflowStartLeaseUntil: true,
          status: true,
        },
      }),
    ]);
    if (child === null) return { outcome: 'settled' };
    assertIdentity(child, identity);
    if (!child.temporalWorkflowStartPending) return { outcome: 'settled' };
    if (
      parent === null ||
      parent.deletedAt !== null ||
      terminalStatus(parent.status) ||
      parent.temporalWorkflowId !== identity.parentWorkflowId ||
      child.temporalWorkflowId !== identity.agentId
    ) {
      return { outcome: 'stale' };
    }
    const leaseUntilMs = child.temporalWorkflowStartLeaseUntil?.getTime() ?? 0;
    if (leaseUntilMs > nowMs) {
      return { outcome: 'leased', retryAfterMs: leaseUntilMs - nowMs };
    }
    const deadlineAtMs = nowMs + leaseMs;
    await tx.agent.update({
      where: { id: identity.agentId },
      data: { temporalWorkflowStartLeaseUntil: new Date(deadlineAtMs) },
    });
    return { outcome: 'claimed', deadlineAtMs };
  });
}

/**
 * Atomically accept an exact child execution or seal it when the parent
 * generation lost the race. A stale execution remains pending until its exact
 * Temporal chain is terminated and durable tool state is reconciled.
 */
export async function finalizeDescendantWorkflowStart(
  identity: DescendantWorkflowStartIdentity,
  execution: TemporalWorkflowExecutionRef
): Promise<DescendantWorkflowStartFinalization> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, identity.parentAgentId);
    await lockAgentWorkflowGeneration(tx, identity.agentId);
    const [parent, child] = await Promise.all([
      tx.agent.findUnique({
        where: { id: identity.parentAgentId },
        select: { temporalWorkflowId: true, deletedAt: true, status: true },
      }),
      tx.agent.findUnique({
        where: { id: identity.agentId },
        select: {
          parentAgentId: true,
          parentWorkflowId: true,
          temporalWorkflowId: true,
          temporalFirstExecutionRunId: true,
          temporalWorkflowStartPending: true,
          status: true,
          staleTemporalWorkflowId: true,
        },
      }),
    ]);
    if (child === null) return { outcome: 'terminal' };
    assertIdentity(child, identity);
    const parentIsCurrent =
      parent !== null &&
      parent.deletedAt === null &&
      !terminalStatus(parent.status) &&
      parent.temporalWorkflowId === identity.parentWorkflowId;
    if (!child.temporalWorkflowStartPending) {
      if (
        parentIsCurrent &&
        child.temporalWorkflowId === execution.workflowId &&
        child.temporalFirstExecutionRunId === execution.firstExecutionRunId
      ) {
        return { outcome: 'accepted' };
      }
      return { outcome: 'terminal' };
    }
    if (parentIsCurrent && child.temporalWorkflowId === identity.agentId) {
      await tx.agent.update({
        where: { id: identity.agentId },
        data: {
          temporalFirstExecutionRunId: execution.firstExecutionRunId,
          ...(terminalStatus(child.status)
            ? {}
            : {
                temporalWorkflowStartPending: false,
                temporalWorkflowStartLeaseUntil: null,
              }),
        },
      });
      return { outcome: terminalStatus(child.status) ? 'terminal' : 'accepted' };
    }

    const sealedWorkflowId =
      child.staleTemporalWorkflowId === execution.workflowId && child.temporalWorkflowId !== null
        ? child.temporalWorkflowId
        : `${identity.agentId}:deployment-sealed:${randomUUID()}`;
    await tx.agent.update({
      where: { id: identity.agentId },
      data: {
        temporalWorkflowId: sealedWorkflowId,
        temporalFirstExecutionRunId: null,
        staleTemporalWorkflowId: execution.workflowId,
        staleTemporalFirstExecutionRunId: execution.firstExecutionRunId,
        statusMessage: 'Updating parent agent code',
      },
    });
    return { outcome: 'stale', sealedWorkflowId };
  });
}

export async function readDescendantWorkflowStartState(
  agentId: string
): Promise<DescendantWorkflowStartState | null> {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      temporalWorkflowId: true,
      temporalFirstExecutionRunId: true,
      temporalWorkflowStartPending: true,
      status: true,
    },
  });
}

/**
 * Drive one deterministic child-start intent. Concurrent HTTP/activity retries
 * wait for the current bounded lease, then either observe its durable result or
 * take over the same immutable Temporal Workflow ID.
 */
export async function executeDescendantWorkflowStart(
  identity: DescendantWorkflowStartIdentity,
  start: (deadlineAtMs: number) => Promise<TemporalWorkflowExecutionRef>,
  waitTimeoutMs = 65_000
): Promise<TemporalWorkflowExecutionRef | null> {
  const waitDeadline = Date.now() + waitTimeoutMs;
  async function claimOrWait(): Promise<TemporalWorkflowExecutionRef | null> {
    const claim = await claimDescendantWorkflowStart(identity);
    if (claim.outcome === 'settled') {
      const state = await readDescendantWorkflowStartState(identity.agentId);
      if (
        state?.temporalWorkflowId === null ||
        state?.temporalWorkflowId === undefined ||
        state.temporalWorkflowId.includes(':deployment-sealed:')
      ) {
        return null;
      }
      if (state.temporalFirstExecutionRunId !== null) {
        return {
          workflowId: state.temporalWorkflowId,
          firstExecutionRunId: state.temporalFirstExecutionRunId,
        };
      }
      try {
        return await resolveTemporalWorkflowExecutionRef(state.temporalWorkflowId);
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return null;
        throw error;
      }
    }
    if (claim.outcome === 'stale') {
      throw new StaleParentWorkflowGenerationError();
    }
    if (claim.outcome === 'leased') {
      if (Date.now() >= waitDeadline) {
        throw new Error('Descendant workflow start remains leased by another request');
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(250, Math.max(1, claim.retryAfterMs)))
      );
      return claimOrWait();
    }
    if (Date.now() >= claim.deadlineAtMs) {
      throw new Error('Descendant workflow start lease expired before Temporal start');
    }
    const execution = await start(claim.deadlineAtMs);
    const finalization = await reconcileStartedDescendantWorkflow(identity, execution);
    if (finalization.outcome === 'stale') {
      throw new StaleParentWorkflowGenerationError();
    }
    return execution;
  }
  return claimOrWait();
}

/** Finish a stale child only after its exact Temporal chain was terminated. */
export async function completeStaleDescendantWorkflowStart(
  identity: DescendantWorkflowStartIdentity
): Promise<void> {
  await runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, identity.agentId);
    const child = await tx.agent.findUnique({
      where: { id: identity.agentId },
      select: {
        parentAgentId: true,
        parentWorkflowId: true,
        temporalWorkflowStartPending: true,
        status: true,
        staleTemporalWorkflowId: true,
      },
    });
    if (child === null) return;
    assertIdentity(child, identity);
    if (!child.temporalWorkflowStartPending) return;
    if (child.status === 'COMPLETED') {
      await tx.agent.update({
        where: { id: identity.agentId },
        data: {
          temporalWorkflowStartPending: false,
          temporalWorkflowStartLeaseUntil: null,
          temporalCleanupPending: false,
        },
      });
      return;
    }
    await tx.agentAttentionRequest.updateMany({
      where: {
        agentId: identity.agentId,
        ...(child.staleTemporalWorkflowId === null
          ? {}
          : { workflowId: child.staleTemporalWorkflowId }),
        userResponse: null,
      },
      data: { userResponse: DEPLOY_INTERRUPTED_TOOL_MESSAGE },
    });
    await tx.agent.update({
      where: { id: identity.agentId },
      data: {
        status: 'FAILED',
        statusMessage: DEPLOY_INTERRUPTED_TOOL_MESSAGE,
        temporalWorkflowStartPending: false,
        temporalWorkflowStartLeaseUntil: null,
        staleTemporalWorkflowId: null,
        staleTemporalFirstExecutionRunId: null,
      },
    });
    await tx.agent.updateMany({
      where: {
        id: identity.agentId,
        temporalWorkflowStartPending: false,
        staleTemporalWorkflowId: null,
      },
      data: { temporalCleanupPending: false },
    });
  });
}

async function completeTerminalDescendantWorkflowStart(agentId: string): Promise<void> {
  await runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    await tx.agent.updateMany({
      where: {
        id: agentId,
        temporalWorkflowStartPending: true,
        status: { in: ['COMPLETED', 'FAILED'] },
      },
      data: {
        temporalWorkflowStartPending: false,
        temporalWorkflowStartLeaseUntil: null,
        temporalCleanupPending: false,
      },
    });
  });
}

/**
 * Postvalidate a just-started execution. If the parent lost the race, seal the
 * child first, then quiesce its exact Temporal chain and terminalize tools.
 */
export async function reconcileStartedDescendantWorkflow(
  identity: DescendantWorkflowStartIdentity,
  execution: TemporalWorkflowExecutionRef,
  dependencyOverrides: Partial<PendingDescendantWorkflowStartDrainDependencies> = {}
): Promise<DescendantWorkflowStartFinalization> {
  const dependencies = { ...defaultDrainDependencies, ...dependencyOverrides };
  const snapshot = await dependencies.captureInProgressTools(
    identity.agentId,
    execution.workflowId
  );
  const finalization = await finalizeDescendantWorkflowStart(identity, execution);
  if (finalization.outcome === 'accepted') return finalization;
  if (finalization.outcome === 'terminal') {
    await dependencies.terminate(execution, identity.agentId);
    await completeTerminalDescendantWorkflowStart(identity.agentId);
    return finalization;
  }
  await dependencies.terminate(execution, identity.agentId);
  await dependencies.finalizeInterruptedTools(identity.agentId, execution.workflowId, snapshot);
  await completeStaleDescendantWorkflowStart(identity);
  return finalization;
}

async function pendingStartsForRoots(
  rootAgentIds: string[]
): Promise<PendingDescendantWorkflowStartRow[]> {
  if (rootAgentIds.length === 0) return [];
  return prisma.$queryRaw<PendingDescendantWorkflowStartRow[]>(Prisma.sql`
    WITH RECURSIVE descendants AS (
      SELECT child.*
      FROM "Agent" child
      WHERE child."parentAgentId" IN (${Prisma.join(rootAgentIds)})
        AND child."deletedAt" IS NULL

      UNION ALL

      SELECT child.*
      FROM "Agent" child
      INNER JOIN descendants parent ON child."parentAgentId" = parent.id
      WHERE child."deletedAt" IS NULL
    )
    SELECT
      id,
      "parentAgentId",
      "parentWorkflowId",
      "temporalWorkflowId",
      "staleTemporalWorkflowId",
      "staleTemporalFirstExecutionRunId",
      "temporalWorkflowStartLeaseUntil",
      status
    FROM descendants
    WHERE "temporalWorkflowStartPending" = true
      AND "parentAgentId" IS NOT NULL
      AND "parentWorkflowId" IS NOT NULL
    ORDER BY depth DESC, id ASC
  `);
}

/**
 * Fence an ambiguous start before probing or claiming its immutable Temporal
 * ID. A current, nonterminal parent is never tombstoned; activation fails
 * closed until the ordinary starter settles it or the parent is sealed.
 */
async function sealPendingDescendantWorkflowStart(
  identity: DescendantWorkflowStartIdentity
): Promise<PendingDescendantWorkflowStartSeal> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, identity.parentAgentId);
    await lockAgentWorkflowGeneration(tx, identity.agentId);
    const [parent, child] = await Promise.all([
      tx.agent.findUnique({
        where: { id: identity.parentAgentId },
        select: { temporalWorkflowId: true, deletedAt: true, status: true },
      }),
      tx.agent.findUnique({
        where: { id: identity.agentId },
        select: {
          parentAgentId: true,
          parentWorkflowId: true,
          temporalWorkflowId: true,
          temporalWorkflowStartPending: true,
          staleTemporalWorkflowId: true,
          status: true,
        },
      }),
    ]);
    if (child === null) return { outcome: 'settled' };
    assertIdentity(child, identity);
    if (!child.temporalWorkflowStartPending) return { outcome: 'settled' };
    if (child.staleTemporalWorkflowId !== null) {
      return { outcome: 'sealed', workflowGeneration: child.staleTemporalWorkflowId };
    }
    const parentIsCurrent =
      parent !== null &&
      parent.deletedAt === null &&
      !terminalStatus(parent.status) &&
      parent.temporalWorkflowId === identity.parentWorkflowId;
    if (parentIsCurrent && !terminalStatus(child.status)) return { outcome: 'current' };

    // Initial descendant starts always use agent ID as their immutable Temporal
    // Workflow ID. Descendant cleanup may already have replaced
    // temporalWorkflowId with a deployment-sealed sentinel and cleared stale
    // identity, so that mutable column must never become the tombstone target.
    const workflowGeneration = identity.agentId;
    const sealedWorkflowId = `${identity.agentId}:deployment-sealed:${randomUUID()}`;
    await tx.agent.update({
      where: { id: identity.agentId },
      data: {
        temporalWorkflowId: sealedWorkflowId,
        temporalFirstExecutionRunId: null,
        staleTemporalWorkflowId: workflowGeneration,
        staleTemporalFirstExecutionRunId: null,
        statusMessage: 'Updating parent agent code',
      },
    });
    return { outcome: 'sealed', workflowGeneration };
  });
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      await task(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, worker)
  );
}

async function reconcilePendingStart(
  row: PendingDescendantWorkflowStartRow,
  dependencies: PendingDescendantWorkflowStartDrainDependencies,
  nowMs: number
): Promise<void> {
  if ((row.temporalWorkflowStartLeaseUntil?.getTime() ?? 0) > nowMs) return;
  const identity: DescendantWorkflowStartIdentity = {
    agentId: row.id,
    parentAgentId: row.parentAgentId,
    parentWorkflowId: row.parentWorkflowId,
  };
  const seal = await sealPendingDescendantWorkflowStart(identity);
  if (seal.outcome === 'settled' || seal.outcome === 'current') return;
  const workflowGeneration = seal.workflowGeneration;
  let execution: TemporalWorkflowExecutionRef;
  try {
    execution =
      row.staleTemporalWorkflowId !== null && row.staleTemporalFirstExecutionRunId !== null
        ? {
            workflowId: row.staleTemporalWorkflowId,
            firstExecutionRunId: row.staleTemporalFirstExecutionRunId,
          }
        : await dependencies.resolveExecution(workflowGeneration);
  } catch (error) {
    if (!(error instanceof WorkflowNotFoundError)) throw error;
    execution = await dependencies.claimExecutionForTermination(workflowGeneration);
  }

  await reconcileStartedDescendantWorkflow(identity, execution, dependencies);
}

const defaultDrainDependencies: PendingDescendantWorkflowStartDrainDependencies = {
  resolveExecution: resolveTemporalWorkflowExecutionRef,
  claimExecutionForTermination: claimTemporalWorkflowIdForTermination,
  terminate: terminateStaleTemporalWorkflow,
  captureInProgressTools: captureInProgressWorkflowTools,
  finalizeInterruptedTools: finalizeInterruptedWorkflowTools,
};

/**
 * Drain the closed set of child-start outbox rows under the frozen roots.
 * Every root generation is already claimed before this runs, so no old worker
 * can commit another intent. Active bounded leases are allowed to finish;
 * crashed/ambiguous starts are resolved by deterministic Workflow ID.
 */
export async function drainPendingDescendantWorkflowStarts(
  rootAgentIds: string[],
  dependencyOverrides: Partial<PendingDescendantWorkflowStartDrainDependencies> = {},
  options: PendingDescendantWorkflowStartDrainOptions = {}
): Promise<number> {
  const dependencies = { ...defaultDrainDependencies, ...dependencyOverrides };
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const concurrency = options.maxConcurrency ?? 8;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Pending descendant start drain timeout must be positive');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('Pending descendant start drain poll interval must be positive');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error('Pending descendant start drain concurrency must be between 1 and 100');
  }
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  const discovered = new Set<string>();

  while (true) {
    const rows = await pendingStartsForRoots(rootAgentIds);
    rows.forEach((row) => discovered.add(row.id));
    if (rows.length === 0) return discovered.size;
    if (now() >= deadline) {
      throw new Error(
        `Pending descendant workflow starts did not drain before activation: ${rows
          .slice(0, 20)
          .map((row) => row.id)
          .join(', ')}`
      );
    }
    await mapWithConcurrency(rows, concurrency, (row) =>
      reconcilePendingStart(row, dependencies, now())
    );
    await sleep(pollIntervalMs);
  }
}
