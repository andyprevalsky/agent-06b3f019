import { randomUUID } from 'node:crypto';
import { type AgentStatus } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import { prisma, runTransactionWithRetry } from './database';
import {
  captureInProgressWorkflowTools,
  closeInterruptedAttentionRequests,
  DEPLOY_INTERRUPTED_TOOL_MESSAGE,
  finalizeInterruptedWorkflowTools,
  type InterruptedWorkflowToolsResult,
  type ToolProgressCandidate,
} from './staleWorkflowTools';
import { resolveTemporalWorkflowExecutionRef, type TemporalWorkflowExecutionRef } from './temporal';
import { terminateStaleTemporalWorkflow } from './workflowReplacement';
import { lockAgentWorkflowGeneration } from './workflowGeneration';

interface DescendantRow {
  id: string;
  status: AgentStatus;
  temporalWorkflowId: string | null;
  temporalFirstExecutionRunId: string | null;
  staleTemporalWorkflowId: string | null;
  staleTemporalFirstExecutionRunId: string | null;
  depth: number;
}

export interface DescendantWorkflowSnapshot {
  agentId: string;
  workflowGeneration: string;
  sealedWorkflowId: string;
  execution: TemporalWorkflowExecutionRef | null;
  inProgressTools: ToolProgressCandidate[];
  depth: number;
}

export interface DescendantWorkflowCleanupResult {
  discovered: number;
  sealed: number;
  skipped: number;
  terminated: number;
  interruptedTools: number;
}

export interface DescendantWorkflowCleanupDependencies {
  captureInProgressTools: (
    agentId: string,
    workflowGeneration: string
  ) => Promise<ToolProgressCandidate[]>;
  resolveExecution: (
    workflowId: string,
    deadlineAtMs?: number
  ) => Promise<TemporalWorkflowExecutionRef>;
  terminate: (
    execution: TemporalWorkflowExecutionRef,
    agentId: string,
    deadlineAtMs?: number
  ) => Promise<void>;
  finalizeInterruptedTools: (
    agentId: string,
    workflowGeneration: string,
    snapshot: ToolProgressCandidate[]
  ) => Promise<InterruptedWorkflowToolsResult>;
}

export interface DescendantWorkflowCleanupOptions {
  maxConcurrency?: number;
  deadlineAtMs?: number;
}

const defaultDependencies: DescendantWorkflowCleanupDependencies = {
  captureInProgressTools: captureInProgressWorkflowTools,
  resolveExecution: resolveTemporalWorkflowExecutionRef,
  terminate: terminateStaleTemporalWorkflow,
  finalizeInterruptedTools: finalizeInterruptedWorkflowTools,
};
const MAX_QUIESCENCE_ATTEMPTS = 5;
const DEFAULT_MAX_CONCURRENCY = 8;

function assertBeforeDeadline(deadlineAtMs: number | undefined, phase: string): void {
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    throw new Error(`Workflow migration deadline exceeded during ${phase}`);
  }
}

function cleanupConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error('Descendant cleanup concurrency must be an integer between 1 and 100');
  }
  return concurrency;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  map: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await map(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, worker)
  );
  return results;
}

async function findNonterminalDescendants(rootAgentId: string): Promise<DescendantRow[]> {
  return prisma.$queryRaw<DescendantRow[]>`
    WITH RECURSIVE descendants AS (
      SELECT
        child.id,
        child.status,
        child."temporalWorkflowId",
        child."temporalFirstExecutionRunId",
        child."staleTemporalWorkflowId",
        child."staleTemporalFirstExecutionRunId",
        child.depth
      FROM "Agent" child
      WHERE child."parentAgentId" = ${rootAgentId}
        AND child."deletedAt" IS NULL

      UNION ALL

      SELECT
        child.id,
        child.status,
        child."temporalWorkflowId",
        child."temporalFirstExecutionRunId",
        child."staleTemporalWorkflowId",
        child."staleTemporalFirstExecutionRunId",
        child.depth
      FROM "Agent" child
      INNER JOIN descendants parent ON child."parentAgentId" = parent.id
      WHERE child."deletedAt" IS NULL
    )
    SELECT *
    FROM descendants
    WHERE status NOT IN ('COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus")
    ORDER BY depth DESC, id ASC
  `;
}

async function executionFor(
  row: DescendantRow,
  workflowGeneration: string,
  dependencies: DescendantWorkflowCleanupDependencies,
  deadlineAtMs?: number
): Promise<TemporalWorkflowExecutionRef | null> {
  const firstExecutionRunId =
    row.staleTemporalWorkflowId === workflowGeneration
      ? row.staleTemporalFirstExecutionRunId
      : row.temporalFirstExecutionRunId;
  if (firstExecutionRunId !== null) {
    return { workflowId: workflowGeneration, firstExecutionRunId };
  }
  if (row.temporalWorkflowId === null && row.staleTemporalWorkflowId === null) return null;
  try {
    return await dependencies.resolveExecution(workflowGeneration, deadlineAtMs);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return null;
    throw error;
  }
}

async function snapshotDescendant(
  row: DescendantRow,
  dependencies: DescendantWorkflowCleanupDependencies,
  deadlineAtMs?: number
): Promise<DescendantWorkflowSnapshot> {
  assertBeforeDeadline(deadlineAtMs, `descendant ${row.id} snapshot`);
  const workflowGeneration = row.staleTemporalWorkflowId ?? row.temporalWorkflowId ?? row.id;
  const [inProgressTools, execution] = await Promise.all([
    dependencies.captureInProgressTools(row.id, workflowGeneration),
    executionFor(row, workflowGeneration, dependencies, deadlineAtMs),
  ]);
  assertBeforeDeadline(deadlineAtMs, `descendant ${row.id} snapshot`);
  return {
    agentId: row.id,
    workflowGeneration,
    sealedWorkflowId:
      row.staleTemporalWorkflowId === workflowGeneration && row.temporalWorkflowId !== null
        ? row.temporalWorkflowId
        : `${row.id}:deployment-sealed:${randomUUID()}`,
    execution,
    inProgressTools,
    depth: row.depth,
  };
}

/** Fence one descendant while retaining the exact stale execution for retries. */
export async function sealDescendantWorkflow(
  snapshot: DescendantWorkflowSnapshot
): Promise<boolean> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, snapshot.agentId);
    const current = await tx.agent.findUnique({
      where: { id: snapshot.agentId },
      select: {
        status: true,
        temporalWorkflowId: true,
        staleTemporalWorkflowId: true,
      },
    });
    if (current === null || current.status === 'COMPLETED' || current.status === 'FAILED') {
      return false;
    }
    if (
      current.temporalWorkflowId === snapshot.sealedWorkflowId &&
      current.staleTemporalWorkflowId === snapshot.workflowGeneration
    ) {
      return true;
    }
    if (current.temporalWorkflowId !== snapshot.workflowGeneration) return false;

    const updated = await tx.agent.updateMany({
      where: {
        id: snapshot.agentId,
        status: { notIn: ['COMPLETED', 'FAILED'] },
        temporalWorkflowId: snapshot.workflowGeneration,
      },
      data: {
        temporalWorkflowId: snapshot.sealedWorkflowId,
        temporalFirstExecutionRunId: null,
        staleTemporalWorkflowId: snapshot.workflowGeneration,
        staleTemporalFirstExecutionRunId: snapshot.execution?.firstExecutionRunId ?? null,
        statusMessage: 'Updating parent agent code',
      },
    });
    return updated.count === 1;
  });
}

async function completeDescendantCleanup(snapshot: DescendantWorkflowSnapshot): Promise<void> {
  await runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, snapshot.agentId);
    await closeInterruptedAttentionRequests(tx, snapshot.agentId, snapshot.workflowGeneration);
    await tx.agent.updateMany({
      where: {
        id: snapshot.agentId,
        temporalWorkflowId: snapshot.sealedWorkflowId,
        staleTemporalWorkflowId: snapshot.workflowGeneration,
        status: { notIn: ['COMPLETED', 'FAILED'] },
      },
      data: {
        status: 'FAILED',
        statusMessage: DEPLOY_INTERRUPTED_TOOL_MESSAGE,
        staleTemporalWorkflowId: null,
        staleTemporalFirstExecutionRunId: null,
      },
    });
    await tx.agent.updateMany({
      where: {
        id: snapshot.agentId,
        temporalWorkflowId: snapshot.sealedWorkflowId,
        staleTemporalWorkflowId: null,
        status: 'FAILED',
      },
      data: { temporalCleanupPending: false },
    });
  });
}

async function cleanupSnapshot(
  snapshot: DescendantWorkflowSnapshot,
  dependencies: DescendantWorkflowCleanupDependencies,
  deadlineAtMs?: number
): Promise<{ sealed: boolean; terminated: boolean; interruptedTools: number }> {
  assertBeforeDeadline(deadlineAtMs, `descendant ${snapshot.agentId} seal`);
  if (!(await sealDescendantWorkflow(snapshot))) {
    return { sealed: false, terminated: false, interruptedTools: 0 };
  }
  assertBeforeDeadline(deadlineAtMs, `descendant ${snapshot.agentId} termination`);
  if (snapshot.execution !== null) {
    await dependencies.terminate(snapshot.execution, snapshot.agentId, deadlineAtMs);
  }
  assertBeforeDeadline(deadlineAtMs, `descendant ${snapshot.agentId} reconciliation`);
  const tools = await dependencies.finalizeInterruptedTools(
    snapshot.agentId,
    snapshot.workflowGeneration,
    snapshot.inProgressTools
  );
  assertBeforeDeadline(deadlineAtMs, `descendant ${snapshot.agentId} completion`);
  await completeDescendantCleanup(snapshot);
  return {
    sealed: true,
    terminated: snapshot.execution !== null,
    interruptedTools: tools.interrupted,
  };
}

/**
 * Stop every open child and grandchild before the replacement root starts.
 * Snapshotting is a separate phase so every execution identity and tool state
 * is frozen before any descendant is mutated.
 */
export async function cleanupNonterminalDescendantWorkflows(
  rootAgentId: string,
  dependencyOverrides: Partial<DescendantWorkflowCleanupDependencies> = {},
  options: DescendantWorkflowCleanupOptions = {}
): Promise<DescendantWorkflowCleanupResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const concurrency = cleanupConcurrency(options.maxConcurrency);
  const discoveredAgentIds = new Set<string>();
  let sealed = 0;
  let terminated = 0;
  let interruptedTools = 0;
  for (let attempt = 1; attempt <= MAX_QUIESCENCE_ATTEMPTS; attempt++) {
    assertBeforeDeadline(options.deadlineAtMs, 'descendant discovery');
    const rows = await findNonterminalDescendants(rootAgentId);
    if (rows.length === 0) {
      return {
        discovered: discoveredAgentIds.size,
        sealed,
        skipped: 0,
        terminated,
        interruptedTools,
      };
    }
    rows.forEach((row) => discoveredAgentIds.add(row.id));
    const snapshots = await mapWithConcurrency(rows, concurrency, (row) =>
      snapshotDescendant(row, dependencies, options.deadlineAtMs)
    );
    const depths = [...new Set(snapshots.map((snapshot) => snapshot.depth))].sort(
      (left, right) => right - left
    );
    for (const depth of depths) {
      const results = await mapWithConcurrency(
        snapshots.filter((snapshot) => snapshot.depth === depth),
        concurrency,
        (snapshot) => cleanupSnapshot(snapshot, dependencies, options.deadlineAtMs)
      );
      for (const result of results) {
        sealed += Number(result.sealed);
        terminated += Number(result.terminated);
        interruptedTools += result.interruptedTools;
      }
    }
  }
  assertBeforeDeadline(options.deadlineAtMs, 'descendant quiescence check');
  const remaining = await findNonterminalDescendants(rootAgentId);
  if (remaining.length === 0) {
    return {
      discovered: discoveredAgentIds.size,
      sealed,
      skipped: 0,
      terminated,
      interruptedTools,
    };
  }
  throw new Error(
    `Descendant workflows did not quiesce after ${MAX_QUIESCENCE_ATTEMPTS} attempts: ${remaining
      .map((row) => row.id)
      .join(', ')}`
  );
}
