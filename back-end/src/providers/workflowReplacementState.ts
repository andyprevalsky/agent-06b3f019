import { randomUUID } from 'node:crypto';
import { Prisma, type Agent, type AgentStatus } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { stringMetadataValue } from './toolLifecycleMessages';
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
  child_tool_counts: Record<string, number>;
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

export interface WorkflowReplacementSkip {
  skipped: true;
  expectedWorkflowId: string;
  currentWorkflowId: string | null;
  frozenWorkflowId: string | null;
}

export interface WorkflowReplacementClaimOptions {
  expectedWorkflowId: string;
}

export type WorkflowReplacementBootstrapAcknowledgement =
  'acknowledged' | 'already_acknowledged' | 'not_found' | 'stale_generation';

const EXCLUDED_CHILD_TOOL_COUNTS = new Set([
  'completion_summary',
  'attempt_completion',
  'request_user_approval',
  'request_user_signup',
]);

interface DescendantAccountingRow {
  id: string;
  parentAgentId: string;
  depth: number;
  tokenCount: number;
  tokensIn: number;
  tokensOut: number;
  treeCostCents: number;
  ownCostCents: number;
}

interface DurableAccounting {
  tokenCount: number;
  tokensIn: number;
  tokensOut: number;
  ownCostCents: number;
  hasLlmUsage: boolean;
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
  const childToolCounts =
    value.child_tool_counts !== null &&
    typeof value.child_tool_counts === 'object' &&
    !Array.isArray(value.child_tool_counts)
      ? value.child_tool_counts
      : {};
  return {
    ...value,
    child_tool_counts: childToolCounts,
  } as unknown as WorkflowResumeState;
}

function booleanRecord(value: Prisma.JsonValue | null): Record<string, boolean> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value).filter((entry): entry is [string, boolean] => {
    return typeof entry[1] === 'boolean';
  });
  return Object.fromEntries(entries);
}

function terminalChildToolCounts(
  messages: Array<{
    agentId: string;
    workflowGeneration: string | null;
    metadata: Prisma.JsonValue | null;
  }>
): Record<string, number> {
  const terminalCalls = new Map<string, string>();
  for (const message of messages) {
    const metadata =
      message.metadata !== null &&
      typeof message.metadata === 'object' &&
      !Array.isArray(message.metadata)
        ? (message.metadata as Record<string, unknown>)
        : null;
    const toolCallId = stringMetadataValue(metadata, 'toolCallId');
    const toolName = stringMetadataValue(metadata, 'toolName');
    if (
      toolCallId === null ||
      toolName === null ||
      metadata?.toolStatus !== 'FINISHED' ||
      metadata.verifierMessage === true ||
      EXCLUDED_CHILD_TOOL_COUNTS.has(toolName)
    ) {
      continue;
    }
    const generation =
      message.workflowGeneration ??
      stringMetadataValue(metadata, 'workflowGeneration') ??
      message.agentId;
    terminalCalls.set(`${message.agentId}:${generation}:${toolCallId}`, toolName);
  }
  const counts: Record<string, number> = {};
  for (const toolName of terminalCalls.values()) {
    counts[toolName] = (counts[toolName] ?? 0) + 1;
  }
  return counts;
}

function llmAccounting(
  usageItems: Prisma.JsonValue,
  current: DurableAccounting
): DurableAccounting {
  if (!Array.isArray(usageItems)) return current;
  for (const item of usageItems) {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || item.type !== 'llm') {
      continue;
    }
    const tokensIn =
      typeof item.tokens_in === 'number' && Number.isFinite(item.tokens_in) ? item.tokens_in : 0;
    const tokensOut =
      typeof item.tokens_out === 'number' && Number.isFinite(item.tokens_out) ? item.tokens_out : 0;
    const cost =
      typeof item.cost_cents === 'number' && Number.isFinite(item.cost_cents) ? item.cost_cents : 0;
    current.tokensIn += Math.max(0, Math.trunc(tokensIn));
    current.tokensOut += Math.max(0, Math.trunc(tokensOut));
    current.tokenCount += Math.max(0, Math.trunc(tokensIn)) + Math.max(0, Math.trunc(tokensOut));
    current.ownCostCents += Math.max(0, cost);
    current.hasLlmUsage = true;
  }
  return current;
}

function durableOwnAccounting(
  rows: Array<{
    id: string;
    tokenCount: number;
    tokensIn: number;
    tokensOut: number;
    ownCostCents: number;
  }>,
  usages: Array<{ agentId: string | null; usageItems: Prisma.JsonValue }>
): Map<string, DurableAccounting> {
  const usageByAgent = new Map<string, DurableAccounting>();
  for (const usage of usages) {
    if (usage.agentId === null) continue;
    const current = usageByAgent.get(usage.agentId) ?? {
      tokenCount: 0,
      tokensIn: 0,
      tokensOut: 0,
      ownCostCents: 0,
      hasLlmUsage: false,
    };
    usageByAgent.set(usage.agentId, llmAccounting(usage.usageItems, current));
  }

  return new Map(
    rows.map((row) => {
      const usage = usageByAgent.get(row.id);
      return [
        row.id,
        {
          tokenCount: usage?.hasLlmUsage === true ? usage.tokenCount : row.tokenCount,
          tokensIn: usage?.hasLlmUsage === true ? usage.tokensIn : row.tokensIn,
          tokensOut: usage?.hasLlmUsage === true ? usage.tokensOut : row.tokensOut,
          // ownCostCents is explicitly an own-agent DB field. ToolUsage closes
          // its debounce window; max prevents either durable source regressing.
          ownCostCents: Math.max(row.ownCostCents, usage?.ownCostCents ?? 0),
          hasLlmUsage: usage?.hasLlmUsage === true,
        },
      ];
    })
  );
}

function descendantSubtreeAccounting(
  descendants: DescendantAccountingRow[],
  ownAccounting: Map<string, DurableAccounting>
): Map<string, DurableAccounting> {
  const totals = new Map(
    descendants.map((descendant) => [descendant.id, { ...ownAccounting.get(descendant.id)! }])
  );
  for (const descendant of descendants.slice().sort((left, right) => right.depth - left.depth)) {
    const ownSubtree = totals.get(descendant.id);
    const parentSubtree = totals.get(descendant.parentAgentId);
    if (ownSubtree === undefined || parentSubtree === undefined) continue;
    parentSubtree.tokenCount += ownSubtree.tokenCount;
    parentSubtree.tokensIn += ownSubtree.tokensIn;
    parentSubtree.tokensOut += ownSubtree.tokensOut;
    parentSubtree.ownCostCents += ownSubtree.ownCostCents;
  }
  return totals;
}

async function buildResumeState(
  tx: Prisma.TransactionClient,
  agent: Agent,
  historicalLaunchConfig?: WorkflowLaunchConfig
): Promise<WorkflowResumeState> {
  const descendants = await tx.$queryRaw<DescendantAccountingRow[]>`
    WITH RECURSIVE descendants AS (
      SELECT
        child.id,
        child."parentAgentId",
        child.depth,
        child."tokenCount",
        child."tokensIn",
        child."tokensOut",
        child."treeCostCents",
        child."ownCostCents"
      FROM "Agent" child
      WHERE child."parentAgentId" = ${agent.id}
        AND child."deletedAt" IS NULL

      UNION ALL

      SELECT
        child.id,
        child."parentAgentId",
        child.depth,
        child."tokenCount",
        child."tokensIn",
        child."tokensOut",
        child."treeCostCents",
        child."ownCostCents"
      FROM "Agent" child
      INNER JOIN descendants parent ON child."parentAgentId" = parent.id
      WHERE child."deletedAt" IS NULL
    )
    SELECT * FROM descendants
  `;
  const accountingAgentIds = [agent.id, ...descendants.map((descendant) => descendant.id)];
  const [terminalChildToolMessages, toolUsages] = await Promise.all([
    descendants.length === 0
      ? Promise.resolve([])
      : tx.message.findMany({
          where: {
            agentId: { in: descendants.map((descendant) => descendant.id) },
            role: 'TOOL',
            metadata: { path: ['toolStatus'], equals: 'FINISHED' },
          },
          select: {
            agentId: true,
            workflowGeneration: true,
            metadata: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
    tx.toolUsage.findMany({
      where: { agentId: { in: accountingAgentIds } },
      select: { agentId: true, usageItems: true },
    }),
  ]);
  const children = descendants.filter((descendant) => descendant.parentAgentId === agent.id);
  const ownAccounting = durableOwnAccounting([agent, ...descendants], toolUsages);
  const rootAccounting = ownAccounting.get(agent.id)!;
  const subtreeAccounting = descendantSubtreeAccounting(descendants, ownAccounting);
  const childrenCostCents = Object.fromEntries(
    children.map((child) => [
      child.id,
      Math.max(child.treeCostCents, subtreeAccounting.get(child.id)?.ownCostCents ?? 0),
    ])
  );
  const childrenTokensIn = Object.fromEntries(
    children.map((child) => [
      child.id,
      subtreeAccounting.get(child.id)?.tokensIn ?? ownAccounting.get(child.id)!.tokensIn,
    ])
  );
  const childrenTokensOut = Object.fromEntries(
    children.map((child) => [
      child.id,
      subtreeAccounting.get(child.id)?.tokensOut ?? ownAccounting.get(child.id)!.tokensOut,
    ])
  );
  const childLastTokens = Object.fromEntries(
    children.map((child) => [
      child.id,
      {
        tokens_in:
          subtreeAccounting.get(child.id)?.tokensIn ?? ownAccounting.get(child.id)!.tokensIn,
        tokens_out:
          subtreeAccounting.get(child.id)?.tokensOut ?? ownAccounting.get(child.id)!.tokensOut,
        token_count:
          subtreeAccounting.get(child.id)?.tokenCount ?? ownAccounting.get(child.id)!.tokenCount,
      },
    ])
  );
  const childTokensIn = Object.values(childrenTokensIn).reduce((total, value) => total + value, 0);
  const childTokensOut = Object.values(childrenTokensOut).reduce(
    (total, value) => total + value,
    0
  );

  return {
    version: 1,
    kind: 'deployment',
    prior_status: agent.status,
    prior_status_message: agent.statusMessage,
    progress: agent.progress,
    token_count: rootAccounting.tokenCount,
    tokens_in: rootAccounting.tokensIn,
    tokens_out: rootAccounting.tokensOut,
    tree_tokens_in: rootAccounting.tokensIn + childTokensIn,
    tree_tokens_out: rootAccounting.tokensOut + childTokensOut,
    context_size: agent.contextSize,
    message_count: agent.messageCount,
    own_cost_cents: rootAccounting.ownCostCents,
    subtree_cost_cents: Math.max(
      agent.treeCostCents,
      rootAccounting.ownCostCents +
        Object.values(childrenCostCents).reduce((total, value) => total + value, 0)
    ),
    children_cost_cents: childrenCostCents,
    children_tokens_in: childrenTokensIn,
    children_tokens_out: childrenTokensOut,
    child_last_tokens: childLastTokens,
    child_tool_counts: terminalChildToolCounts(terminalChildToolMessages),
    iteration_offset: agent.workflowIterationOffset,
    max_iterations: agent.workflowMaxIterations ?? historicalLaunchConfig?.maxIterations ?? null,
    context_gates:
      booleanRecord(agent.workflowContextGates) ?? historicalLaunchConfig?.contextGates ?? null,
  };
}

/** Atomically seal the old workflow generation and reserve one replacement ID. */
export function claimWorkflowReplacement(
  agentId: string,
  historicalLaunchConfig?: WorkflowLaunchConfig
): Promise<WorkflowReplacementClaim>;
export function claimWorkflowReplacement(
  agentId: string,
  historicalLaunchConfig: WorkflowLaunchConfig | undefined,
  options: WorkflowReplacementClaimOptions
): Promise<WorkflowReplacementClaim | WorkflowReplacementSkip>;
export async function claimWorkflowReplacement(
  agentId: string,
  historicalLaunchConfig?: WorkflowLaunchConfig,
  options?: WorkflowReplacementClaimOptions
): Promise<WorkflowReplacementClaim | WorkflowReplacementSkip> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const agent = await tx.agent.findUnique({ where: { id: agentId } });
    if (agent === null) throw new Error(`Agent ${agentId} was deleted during restart`);

    if (
      options !== undefined &&
      agent.temporalWorkflowId !== options.expectedWorkflowId &&
      !(
        agent.workflowReplacementToken !== null &&
        agent.staleTemporalWorkflowId === options.expectedWorkflowId
      )
    ) {
      return {
        skipped: true,
        expectedWorkflowId: options.expectedWorkflowId,
        currentWorkflowId: agent.temporalWorkflowId,
        frozenWorkflowId: agent.staleTemporalWorkflowId,
      };
    }

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

/**
 * Rebuild the durable snapshot only after the stale root and all descendants
 * have been fenced and reconciled. The claim lock keeps the replacement
 * generation stable while the final DB/ToolUsage accounting is captured.
 */
export async function refreshWorkflowReplacementResumeState(
  claim: WorkflowReplacementClaim
): Promise<WorkflowReplacementClaim> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, claim.agentId);
    const agent = await tx.agent.findUnique({ where: { id: claim.agentId } });
    if (
      agent === null ||
      agent.workflowReplacementToken !== claim.token ||
      agent.temporalWorkflowId !== claim.plannedWorkflowId
    ) {
      throw new Error(`Workflow replacement claim for ${claim.agentId} is no longer current`);
    }

    const previous = savedResumeState(agent.workflowReplacementState);
    const rebuilt = await buildResumeState(tx, agent, {
      maxIterations: previous.max_iterations,
      contextGates: previous.context_gates,
    });
    // Claiming temporarily writes STARTING_UP/Updating agent code. Preserve the
    // pre-claim user state unless a serialized pause/resume mutation won after
    // the claim and changed the Agent status to something else.
    const resumeState: WorkflowResumeState =
      agent.status === 'STARTING_UP'
        ? {
            ...rebuilt,
            prior_status: previous.prior_status,
            prior_status_message: previous.prior_status_message,
          }
        : rebuilt;
    await tx.agent.update({
      where: { id: claim.agentId },
      data: {
        workflowReplacementState: resumeState as unknown as Prisma.InputJsonObject,
      },
    });
    return { ...claim, resumeState };
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

/**
 * Persist Temporal's acceptance without consuming the recovery snapshot.
 * A worker can remain unscheduled or fail its first task after this returns.
 */
export async function recordWorkflowReplacementStartAcceptance(
  claim: WorkflowReplacementClaim,
  execution: TemporalWorkflowExecutionRef
): Promise<boolean> {
  const result = await prisma.agent.updateMany({
    where: {
      id: claim.agentId,
      temporalWorkflowId: claim.plannedWorkflowId,
    },
    data: {
      temporalWorkflowId: execution.workflowId,
      temporalFirstExecutionRunId: execution.firstExecutionRunId,
    },
  });
  return result.count === 1;
}

/**
 * Consume a replacement claim only after the candidate worker restored its
 * snapshot and reached the explicit bootstrap acknowledgement activity.
 */
export async function acknowledgeWorkflowReplacementBootstrap(
  agentId: string,
  workflowGeneration: string
): Promise<WorkflowReplacementBootstrapAcknowledgement> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const agent = await tx.agent.findUnique({
      where: { id: agentId },
      select: {
        temporalWorkflowId: true,
        workflowReplacementToken: true,
      },
    });
    if (agent === null) return 'not_found';
    if (agent.temporalWorkflowId !== workflowGeneration) return 'stale_generation';
    if (agent.workflowReplacementToken === null) return 'already_acknowledged';

    const result = await tx.agent.updateMany({
      where: {
        id: agentId,
        temporalWorkflowId: workflowGeneration,
        workflowReplacementToken: agent.workflowReplacementToken,
      },
      data: {
        workflowReplacementToken: null,
        workflowReplacementState: Prisma.DbNull,
        staleTemporalWorkflowId: null,
        staleTemporalFirstExecutionRunId: null,
      },
    });
    return result.count === 1 ? 'acknowledged' : 'stale_generation';
  });
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
