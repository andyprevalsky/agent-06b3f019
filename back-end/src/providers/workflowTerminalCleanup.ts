import { randomUUID } from 'node:crypto';
import type { AgentStatus, Prisma } from '@prisma/client';
import { WorkflowNotFoundError } from '@temporalio/client';
import { prisma, runTransactionWithRetry } from './database';
import {
  captureInProgressWorkflowTools,
  finalizeInterruptedWorkflowTools,
  type ToolProgressCandidate,
} from './staleWorkflowTools';
import {
  getTemporalClient,
  resolveTemporalWorkflowExecutionRef,
  type TemporalWorkflowExecutionRef,
} from './temporal';
import { lockAgentWorkflowGeneration } from './workflowGeneration';
import { terminateStaleTemporalWorkflow } from './workflowReplacement';

const CLEANUP_LEASE_MS = 60_000;
const CLEANUP_RETRY_DELAY_MS = 60_000;
/** Same grace the schema trigger gives every terminal transition. */
const TERMINAL_CLEANUP_GRACE_MS = 5 * 60_000;
const TERMINAL_AGENT_STATUSES = ['COMPLETED', 'FAILED'] as const;

interface CleanupObligation {
  agentId: string;
  workflowId: string;
  firstExecutionRunId: string | null;
  leaseToken: string;
}

interface CleanupSnapshot extends CleanupObligation {
  inProgressTools: ToolProgressCandidate[];
}

export interface WorkflowTerminalCleanupDependencies {
  resolveExecution: (
    workflowId: string,
    deadlineAtMs?: number
  ) => Promise<TemporalWorkflowExecutionRef>;
  terminate: (
    execution: TemporalWorkflowExecutionRef,
    agentId: string,
    deadlineAtMs?: number
  ) => Promise<void>;
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

export interface WorkflowTerminalCleanupOptions {
  maxConcurrency?: number;
  deadlineAtMs?: number;
  batchSize?: number;
  agentIds?: string[];
  ignoreGrace?: boolean;
}

export interface WorkflowTerminalCleanupResult {
  discovered: number;
  sealed: number;
  terminated: number;
  /** Obligations left alone because their workflow id now names a newer chain. */
  superseded: number;
  interruptedGenerations: number;
}

/**
 * `sealed`: the agent is still ended on this chain and was fenced off it.
 * `released`: the agent already moved to another workflow id.
 * `live`: the agent is live again under the same workflow id; see sealCleanup.
 * `rebound`: a newer chain under the same id ended too; see rebindCleanup.
 */
type CleanupScope = 'sealed' | 'released' | 'live' | 'rebound';

const defaultDependencies: WorkflowTerminalCleanupDependencies = {
  resolveExecution: resolveTemporalWorkflowExecutionRef,
  terminate: terminateStaleTemporalWorkflow,
  captureInProgressTools: captureInProgressWorkflowTools,
  finalizeInterruptedTools: finalizeInterruptedWorkflowTools,
};

function assertBeforeDeadline(deadlineAtMs: number | undefined, phase: string): void {
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    throw new Error(`Workflow migration deadline exceeded during ${phase}`);
  }
}

function boundedConcurrency(value: number | undefined): number {
  const concurrency = value ?? 8;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 100) {
    throw new Error('Terminal workflow cleanup concurrency must be an integer between 1 and 100');
  }
  return concurrency;
}

async function mapConcurrently<T>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<void>
): Promise<unknown[]> {
  let cursor = 0;
  const failures: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        await task(values[index]);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, values.length)) }, worker)
  );
  return failures;
}

async function cleanupCandidates(batchSize: number, options: WorkflowTerminalCleanupOptions) {
  if (options.agentIds?.length === 0) return [];
  const now = new Date();
  return prisma.temporalWorkflowCleanup.findMany({
    where: {
      ...(options.agentIds === undefined ? {} : { agentId: { in: options.agentIds } }),
      ...(options.ignoreGrace === true ? {} : { notBefore: { lte: now } }),
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    orderBy: [{ notBefore: 'asc' }, { agentId: 'asc' }, { workflowId: 'asc' }],
    take: Math.min(batchSize * 2, 2_000),
  });
}

async function claimCleanup(
  candidate: Awaited<ReturnType<typeof cleanupCandidates>>[number],
  options: WorkflowTerminalCleanupOptions
): Promise<CleanupObligation | null> {
  const leaseToken = randomUUID();
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, candidate.agentId);
    const now = new Date();
    const otherLease = await tx.temporalWorkflowCleanup.findFirst({
      where: {
        agentId: candidate.agentId,
        leaseUntil: { gte: now },
      },
      select: { workflowId: true },
    });
    if (otherLease !== null) return null;
    const claimed = await tx.temporalWorkflowCleanup.updateMany({
      where: {
        agentId: candidate.agentId,
        workflowId: candidate.workflowId,
        ...(options.ignoreGrace === true ? {} : { notBefore: { lte: now } }),
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
      },
      data: {
        leaseToken,
        leaseUntil: new Date(now.getTime() + CLEANUP_LEASE_MS),
      },
    });
    if (claimed.count !== 1) return null;
    return {
      agentId: candidate.agentId,
      workflowId: candidate.workflowId,
      firstExecutionRunId: candidate.firstExecutionRunId,
      leaseToken,
    };
  });
}

async function claimCleanupBatch(
  batchSize: number,
  options: WorkflowTerminalCleanupOptions
): Promise<CleanupObligation[]> {
  const candidates = await cleanupCandidates(batchSize, options);
  const uniqueAgents = new Set<string>();
  const claims: CleanupObligation[] = [];
  for (const candidate of candidates) {
    if (claims.length >= batchSize) break;
    if (uniqueAgents.has(candidate.agentId)) continue;
    uniqueAgents.add(candidate.agentId);
    const claim = await claimCleanup(candidate, options);
    if (claim !== null) claims.push(claim);
  }
  return claims;
}

/** Remove a held obligation and recompute the agent's pending-cleanup flag. */
async function dischargeCleanup(
  tx: Prisma.TransactionClient,
  obligation: CleanupObligation
): Promise<void> {
  const deleted = await tx.temporalWorkflowCleanup.deleteMany({
    where: {
      agentId: obligation.agentId,
      workflowId: obligation.workflowId,
      leaseToken: obligation.leaseToken,
    },
  });
  if (deleted.count !== 1) {
    throw new Error(`Cleanup lease was lost for ${obligation.agentId}/${obligation.workflowId}`);
  }
  const remaining = await tx.temporalWorkflowCleanup.count({
    where: { agentId: obligation.agentId },
  });
  await tx.agent.updateMany({
    where: { id: obligation.agentId },
    data: { temporalCleanupPending: remaining > 0 },
  });
}

/**
 * Hold the claimed obligation row for the rest of the transaction. The schema
 * trigger merges a later terminal transition into this row with ON CONFLICT,
 * so the agent row must be read only after any such merge has committed.
 */
async function lockClaimedCleanup(
  tx: Prisma.TransactionClient,
  obligation: CleanupObligation
): Promise<void> {
  const held = await tx.$queryRaw<Array<{ held: number }>>`
    SELECT 1 AS held FROM "TemporalWorkflowCleanup"
    WHERE "agentId" = ${obligation.agentId}
      AND "workflowId" = ${obligation.workflowId}
      AND "leaseToken" = ${obligation.leaseToken}
    FOR UPDATE
  `;
  if (held.length !== 1) {
    throw new Error(`Cleanup lease was lost for ${obligation.agentId}/${obligation.workflowId}`);
  }
}

/**
 * The obligation's chain ended, but the agent has since run another chain
 * under the same workflow id, and that chain has ended too. The trigger keys
 * obligations by (agent, workflow id), so it merged the newer terminal
 * transition into this row. Point the row at the newer chain and give that
 * chain its own grace for final-summary tail work.
 */
async function rebindCleanup(
  tx: Prisma.TransactionClient,
  obligation: CleanupObligation,
  firstExecutionRunId: string
): Promise<void> {
  const rebound = await tx.temporalWorkflowCleanup.updateMany({
    where: {
      agentId: obligation.agentId,
      workflowId: obligation.workflowId,
      leaseToken: obligation.leaseToken,
    },
    data: {
      firstExecutionRunId,
      notBefore: new Date(Date.now() + TERMINAL_CLEANUP_GRACE_MS),
      leaseToken: null,
      leaseUntil: null,
    },
  });
  if (rebound.count !== 1) {
    throw new Error(`Cleanup lease was lost for ${obligation.agentId}/${obligation.workflowId}`);
  }
}

/**
 * Seal and clean only an agent that is still ended on this workflow id.
 *
 * Root follow-ups restart under the same workflow id (the agent id). Once the
 * agent is live again, that id names its live workflow. Temporal keeps at most
 * one open run per workflow id, so the ended chain is closed, or a start
 * adopted it as the live chain. A live agent therefore owns whatever the id
 * runs, and nothing about it may be sealed, terminated or reconciled.
 */
async function sealCleanup(obligation: CleanupObligation): Promise<CleanupScope> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, obligation.agentId);
    await lockClaimedCleanup(tx, obligation);
    const current = await tx.agent.findUnique({
      where: { id: obligation.agentId },
      select: {
        status: true,
        deletedAt: true,
        temporalWorkflowId: true,
        temporalFirstExecutionRunId: true,
      },
    });
    if (current === null) return 'released';
    if (current.temporalWorkflowId !== obligation.workflowId) return 'released';
    const ended =
      current.deletedAt !== null ||
      (TERMINAL_AGENT_STATUSES as readonly AgentStatus[]).includes(current.status);
    if (!ended) {
      await dischargeCleanup(tx, obligation);
      return 'live';
    }
    const currentRunId = current.temporalFirstExecutionRunId;
    if (currentRunId !== null && currentRunId !== obligation.firstExecutionRunId) {
      await rebindCleanup(tx, obligation, currentRunId);
      return 'rebound';
    }
    await tx.agent.update({
      where: { id: obligation.agentId },
      data: {
        temporalWorkflowId: `${obligation.agentId}:deployment-sealed:${randomUUID()}`,
        temporalFirstExecutionRunId: null,
        toolsInUse: [],
      },
    });
    return 'sealed';
  });
}

async function finishCleanup(snapshot: CleanupSnapshot): Promise<void> {
  await runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, snapshot.agentId);
    await dischargeCleanup(tx, snapshot);
  });
}

async function retainFailedCleanup(obligation: CleanupObligation, error: unknown): Promise<void> {
  await prisma.temporalWorkflowCleanup.updateMany({
    where: {
      agentId: obligation.agentId,
      workflowId: obligation.workflowId,
      leaseToken: obligation.leaseToken,
    },
    data: {
      leaseToken: null,
      leaseUntil: null,
      notBefore: new Date(Date.now() + CLEANUP_RETRY_DELAY_MS),
      attemptCount: { increment: 1 },
      lastError: error instanceof Error ? error.message : String(error),
    },
  });
}

async function cleanupOne(
  obligation: CleanupObligation,
  dependencies: WorkflowTerminalCleanupDependencies,
  deadlineAtMs?: number
): Promise<{ scope: CleanupScope; terminated: boolean }> {
  assertBeforeDeadline(deadlineAtMs, `terminal workflow ${obligation.agentId} capture`);
  const inProgressTools = await dependencies.captureInProgressTools(
    obligation.agentId,
    obligation.workflowId
  );
  const scope = await sealCleanup(obligation);
  if (scope === 'live' || scope === 'rebound') return { scope, terminated: false };
  let execution: TemporalWorkflowExecutionRef | null =
    obligation.firstExecutionRunId === null
      ? null
      : {
          workflowId: obligation.workflowId,
          firstExecutionRunId: obligation.firstExecutionRunId,
        };
  if (execution === null) {
    try {
      execution = await dependencies.resolveExecution(obligation.workflowId, deadlineAtMs);
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
  }
  if (execution !== null) {
    assertBeforeDeadline(deadlineAtMs, `terminal workflow ${obligation.agentId} termination`);
    await dependencies.terminate(execution, obligation.agentId, deadlineAtMs);
  }
  assertBeforeDeadline(deadlineAtMs, `terminal workflow ${obligation.agentId} reconciliation`);
  await dependencies.finalizeInterruptedTools(
    obligation.agentId,
    obligation.workflowId,
    inProgressTools
  );
  await finishCleanup({ ...obligation, inProgressTools });
  return { scope, terminated: execution !== null };
}

/**
 * Exact cleanup for every per-generation durable obligation. Claims are
 * serialized per agent and leased across replicas; failures are retained with
 * backoff so a poison row cannot starve later generations.
 */
export async function cleanupTerminalAgentWorkflowZombies(
  dependencyOverrides: Partial<WorkflowTerminalCleanupDependencies> = {},
  options: WorkflowTerminalCleanupOptions = {}
): Promise<WorkflowTerminalCleanupResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const concurrency = boundedConcurrency(options.maxConcurrency);
  const batchSize = options.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error('Terminal workflow cleanup batch size must be an integer between 1 and 1000');
  }
  const discovered = new Set<string>();
  let sealed = 0;
  let terminated = 0;
  let superseded = 0;
  let interruptedGenerations = 0;

  while (true) {
    assertBeforeDeadline(options.deadlineAtMs, 'terminal workflow cleanup discovery');
    const claims = await claimCleanupBatch(batchSize, options);
    if (claims.length === 0) {
      return {
        discovered: discovered.size,
        sealed,
        terminated,
        superseded,
        interruptedGenerations,
      };
    }
    for (const claim of claims) discovered.add(`${claim.agentId}:${claim.workflowId}`);
    const failures = await mapConcurrently(claims, concurrency, async (claim) => {
      try {
        const result = await cleanupOne(claim, dependencies, options.deadlineAtMs);
        sealed += Number(result.scope === 'sealed');
        terminated += Number(result.terminated);
        const left = result.scope === 'live' || result.scope === 'rebound';
        superseded += Number(left);
        interruptedGenerations += Number(!left);
      } catch (error) {
        await retainFailedCleanup(claim, error);
        throw error;
      }
    });
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `${failures.length} Temporal cleanup obligation(s) failed`
      );
    }
  }
}

/**
 * The schema trigger covers every transition after migration. This one-time
 * visibility sweep seeds only DB-terminal/deleted executions Temporal still
 * reports RUNNING, avoiding a describe call for every historical closed row.
 */
export async function discoverRunningTerminalWorkflowCleanupObligations(
  deadlineAtMs?: number
): Promise<number> {
  const client = await getTemporalClient();
  const running: Array<{ workflowId: string; runId: string | null }> = [];
  const discoverRunning = async (): Promise<void> => {
    for await (const execution of client.workflow.list({
      query: 'ExecutionStatus = "Running"',
    })) {
      assertBeforeDeadline(deadlineAtMs, 'running terminal workflow discovery');
      running.push({ workflowId: execution.workflowId, runId: execution.runId ?? null });
    }
  };
  if (deadlineAtMs === undefined) {
    await discoverRunning();
  } else {
    await client.withDeadline(deadlineAtMs, discoverRunning);
  }
  let seeded = 0;
  const now = new Date();
  for (let offset = 0; offset < running.length; offset += 500) {
    assertBeforeDeadline(deadlineAtMs, 'running terminal workflow reconciliation');
    const batch = running.slice(offset, offset + 500);
    const byWorkflow = new Map(batch.map((item) => [item.workflowId, item.runId]));
    const workflowIds = [...byWorkflow.keys()];
    const agents = await prisma.agent.findMany({
      where: {
        OR: [
          { temporalWorkflowId: { in: workflowIds } },
          { staleTemporalWorkflowId: { in: workflowIds } },
        ],
        AND: [
          {
            OR: [{ status: { in: [...TERMINAL_AGENT_STATUSES] } }, { deletedAt: { not: null } }],
          },
        ],
      },
      select: {
        id: true,
        temporalWorkflowId: true,
        temporalFirstExecutionRunId: true,
        staleTemporalWorkflowId: true,
        staleTemporalFirstExecutionRunId: true,
      },
    });
    const obligations = agents.flatMap((agent) => {
      const matches = [
        {
          workflowId: agent.temporalWorkflowId,
          firstExecutionRunId: agent.temporalFirstExecutionRunId,
        },
        {
          workflowId: agent.staleTemporalWorkflowId,
          firstExecutionRunId: agent.staleTemporalFirstExecutionRunId,
        },
      ];
      return matches.flatMap((match) => {
        if (match.workflowId === null || !byWorkflow.has(match.workflowId)) return [];
        return [
          {
            agentId: agent.id,
            workflowId: match.workflowId,
            firstExecutionRunId: match.firstExecutionRunId ?? byWorkflow.get(match.workflowId),
            notBefore: now,
          },
        ];
      });
    });
    if (obligations.length === 0) continue;
    const created = await prisma.temporalWorkflowCleanup.createMany({
      data: obligations,
      skipDuplicates: true,
    });
    seeded += created.count;
    await prisma.agent.updateMany({
      where: { id: { in: obligations.map((item) => item.agentId) } },
      data: { temporalCleanupPending: true },
    });
  }
  return seeded;
}

export async function assertNoPendingTerminalAgentWorkflowCleanup(
  agentIds?: string[]
): Promise<void> {
  if (agentIds?.length === 0) return;
  const pending = await prisma.temporalWorkflowCleanup.findMany({
    where: agentIds === undefined ? {} : { agentId: { in: agentIds } },
    orderBy: [{ agentId: 'asc' }, { workflowId: 'asc' }],
    take: 20,
    select: { agentId: true, workflowId: true },
  });
  if (pending.length > 0) {
    throw new Error(
      `Refusing worker activation while ${pending.length}${pending.length === 20 ? '+' : ''} workflow cleanup obligation(s) remain: ${pending
        .map((row) => `${row.agentId}/${row.workflowId}`)
        .join(', ')}`
    );
  }
}
