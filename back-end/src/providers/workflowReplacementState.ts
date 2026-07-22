import { randomUUID } from 'node:crypto';
import { Prisma, type Agent, type AgentStatus } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { lockAgentWorkflowGeneration } from './workflowGeneration';
import type { TemporalWorkflowExecutionRef } from './temporal';

export interface WorkflowResumeState {
  version: 1;
  kind: 'deployment';
  prior_status: AgentStatus;
  prior_status_message: string | null;
  progress: number;
  token_count: number;
  tokens_in: number;
  tokens_out: number;
  tree_tokens_in: number;
  tree_tokens_out: number;
  context_size: number;
  message_count: number;
  own_cost_cents: number;
  subtree_cost_cents: number;
  children_cost_cents: Record<string, number>;
  children_tokens_in: Record<string, number>;
  children_tokens_out: Record<string, number>;
  child_last_tokens: Record<string, { tokens_in: number; tokens_out: number; token_count: number }>;
  iteration_offset: number;
  max_iterations: number | null;
  context_gates: Record<string, boolean> | null;
}

export interface WorkflowLaunchConfig {
  maxIterations: number | null;
  contextGates: Record<string, boolean> | null;
}

export interface WorkflowReplacementClaim {
  agentId: string;
  token: string;
  plannedWorkflowId: string;
  staleWorkflowId: string | null;
  staleFirstExecutionRunId: string | null;
  resumeState: WorkflowResumeState;
}

function savedResumeState(value: Prisma.JsonValue | null): WorkflowResumeState {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    value.kind !== 'deployment'
  ) {
    throw new Error('Workflow replacement claim is missing its durable resume state');
  }
  return value as unknown as WorkflowResumeState;
}

function booleanRecord(value: Prisma.JsonValue | null): Record<string, boolean> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, boolean] => {
    return typeof entry[1] === 'boolean';
  });
  return Object.fromEntries(entries);
}

function durableIterationOffset(rows: Array<{ usageItems: Prisma.JsonValue }>): number {
  const iterations = rows.flatMap((row) => {
    if (!Array.isArray(row.usageItems)) return [];
    return row.usageItems.flatMap((item) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return [];
      return Number.isInteger(item.iteration) && Number(item.iteration) >= 0
        ? [Number(item.iteration)]
        : [];
    });
  });
  return iterations.length > 0 ? Math.max(...iterations) : rows.length;
}

async function buildResumeState(
  tx: Prisma.TransactionClient,
  agent: Agent,
  historicalLaunchConfig?: WorkflowLaunchConfig
): Promise<WorkflowResumeState> {
  const [children, iterationRows] = await Promise.all([
    tx.agent.findMany({
      where: { parentAgentId: agent.id },
      select: {
        id: true,
        tokenCount: true,
        tokensIn: true,
        tokensOut: true,
        treeCostCents: true,
      },
    }),
    tx.toolUsage.findMany({
      where: { agentId: agent.id, toolName: 'execute_loop' },
      select: { usageItems: true },
    }),
  ]);
  const iterationOffset = durableIterationOffset(iterationRows);
  const childrenCostCents = Object.fromEntries(
    children.map((child) => [child.id, child.treeCostCents])
  );
  const childrenTokensIn = Object.fromEntries(children.map((child) => [child.id, child.tokensIn]));
  const childrenTokensOut = Object.fromEntries(
    children.map((child) => [child.id, child.tokensOut])
  );
  const childLastTokens = Object.fromEntries(
    children.map((child) => [
      child.id,
      {
        tokens_in: child.tokensIn,
        tokens_out: child.tokensOut,
        token_count: child.tokenCount,
      },
    ])
  );
  const childTokenCount = children.reduce((total, child) => total + child.tokenCount, 0);
  const childTokensIn = children.reduce((total, child) => total + child.tokensIn, 0);
  const childTokensOut = children.reduce((total, child) => total + child.tokensOut, 0);
  const dbTokensAreOwn = agent.status === 'COST_LIMIT_REACHED';
  const ownTokensIn = dbTokensAreOwn ? agent.tokensIn : Math.max(0, agent.tokensIn - childTokensIn);
  const ownTokensOut = dbTokensAreOwn
    ? agent.tokensOut
    : Math.max(0, agent.tokensOut - childTokensOut);

  return {
    version: 1,
    kind: 'deployment',
    prior_status: agent.status,
    prior_status_message: agent.statusMessage,
    progress: agent.progress,
    token_count: Math.max(0, agent.tokenCount - childTokenCount),
    tokens_in: ownTokensIn,
    tokens_out: ownTokensOut,
    tree_tokens_in: ownTokensIn + childTokensIn,
    tree_tokens_out: ownTokensOut + childTokensOut,
    context_size: agent.contextSize,
    message_count: agent.messageCount,
    own_cost_cents: agent.ownCostCents,
    subtree_cost_cents: agent.treeCostCents,
    children_cost_cents: childrenCostCents,
    children_tokens_in: childrenTokensIn,
    children_tokens_out: childrenTokensOut,
    child_last_tokens: childLastTokens,
    iteration_offset: iterationOffset,
    max_iterations: agent.workflowMaxIterations ?? historicalLaunchConfig?.maxIterations ?? null,
    context_gates:
      booleanRecord(agent.workflowContextGates) ?? historicalLaunchConfig?.contextGates ?? null,
  };
}

/** Atomically seal the old workflow generation and reserve one replacement ID. */
export async function claimWorkflowReplacement(
  agentId: string,
  historicalLaunchConfig?: WorkflowLaunchConfig
): Promise<WorkflowReplacementClaim> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const agent = await tx.agent.findUnique({ where: { id: agentId } });
    if (agent === null) throw new Error(`Agent ${agentId} was deleted during restart`);

    if (agent.workflowReplacementToken !== null) {
      if (agent.temporalWorkflowId === null) {
        throw new Error(`Agent ${agentId} has an incomplete workflow replacement claim`);
      }
      return {
        agentId,
        token: agent.workflowReplacementToken,
        plannedWorkflowId: agent.temporalWorkflowId,
        staleWorkflowId: agent.staleTemporalWorkflowId,
        staleFirstExecutionRunId: agent.staleTemporalFirstExecutionRunId,
        resumeState: savedResumeState(agent.workflowReplacementState),
      };
    }

    const resumeState = await buildResumeState(tx, agent, historicalLaunchConfig);
    const token = randomUUID();
    const plannedWorkflowId = `${agentId}:replacement:${token}`;
    const updated = await tx.agent.update({
      where: { id: agentId },
      data: {
        workflowReplacementToken: token,
        workflowReplacementState: resumeState as unknown as Prisma.InputJsonObject,
        workflowMaxIterations: resumeState.max_iterations,
        workflowContextGates:
          resumeState.context_gates === null
            ? Prisma.DbNull
            : (resumeState.context_gates as Prisma.InputJsonObject),
        staleTemporalWorkflowId: agent.temporalWorkflowId,
        staleTemporalFirstExecutionRunId: agent.temporalFirstExecutionRunId,
        temporalWorkflowId: plannedWorkflowId,
        temporalFirstExecutionRunId: null,
        status: 'STARTING_UP',
        statusMessage: 'Updating agent code',
      },
    });
    return {
      agentId,
      token,
      plannedWorkflowId,
      staleWorkflowId: updated.staleTemporalWorkflowId,
      staleFirstExecutionRunId: updated.staleTemporalFirstExecutionRunId,
      resumeState,
    };
  });
}

export async function recordStaleWorkflowChain(
  claim: WorkflowReplacementClaim,
  execution: TemporalWorkflowExecutionRef
): Promise<void> {
  await prisma.agent.updateMany({
    where: {
      id: claim.agentId,
      workflowReplacementToken: claim.token,
      staleTemporalWorkflowId: execution.workflowId,
    },
    data: { staleTemporalFirstExecutionRunId: execution.firstExecutionRunId },
  });
}

export async function completeWorkflowReplacement(
  claim: WorkflowReplacementClaim,
  execution: TemporalWorkflowExecutionRef
): Promise<boolean> {
  const result = await prisma.agent.updateMany({
    where: {
      id: claim.agentId,
      workflowReplacementToken: claim.token,
      temporalWorkflowId: claim.plannedWorkflowId,
    },
    data: {
      temporalWorkflowId: execution.workflowId,
      temporalFirstExecutionRunId: execution.firstExecutionRunId,
      workflowReplacementToken: null,
      workflowReplacementState: Prisma.DbNull,
      staleTemporalWorkflowId: null,
      staleTemporalFirstExecutionRunId: null,
    },
  });
  return result.count === 1;
}

/** Keep the claim resumable and the old generation sealed after a failed start. */
export async function markWorkflowReplacementFailed(
  claim: WorkflowReplacementClaim,
  error: unknown
): Promise<void> {
  await prisma.agent.updateMany({
    where: {
      id: claim.agentId,
      workflowReplacementToken: claim.token,
      temporalWorkflowId: claim.plannedWorkflowId,
    },
    data: {
      statusMessage: `Workflow update failed: ${error instanceof Error ? error.message : String(error)}`,
    },
  });
}
