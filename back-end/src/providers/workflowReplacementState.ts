import { randomUUID } from 'node:crypto';
import { Prisma, type Agent, type AgentStatus } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import { lockAgentWorkflowGeneration } from './workflowGeneration';
import type { TemporalWorkflowExecutionRef } from './temporal';
import {
  booleanRecord,
  savedResumeState,
  type WorkflowResumeState,
} from './workflowReplacementResumeState';

export type { WorkflowResumeState } from './workflowReplacementResumeState';
export {
  recordWorkflowResumeIntent,
  rollbackWorkflowResumeIntent,
  type WorkflowResumeIntentResult,
} from './workflowReplacementControlState';
export {
  acknowledgeWorkflowReplacementBootstrap,
  finalizeWorkflowReplacementBootstrap,
  markWorkflowReplacementFailed,
  recordWorkflowReplacementStartAcceptance,
  type WorkflowReplacementBootstrapAcknowledgement,
  type WorkflowReplacementBootstrapState,
} from './workflowReplacementBootstrapState';

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
  deploymentAttempt?: string;
}

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
  status: AgentStatus;
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
  hasCheckpoint: boolean;
}

interface UsageAccountingRow {
  agentId: string;
  legacyTokenCount: bigint;
  legacyTokensIn: bigint;
  legacyTokensOut: bigint;
  legacyOwnCostCents: number;
  legacyLlmItems: bigint;
  tokenCountCheckpoint: number | null;
  tokensInCheckpoint: number | null;
  tokensOutCheckpoint: number | null;
  ownCostCheckpointCents: number | null;
}

function durableOwnAccounting(
  rows: Array<{
    id: string;
    tokenCount: number;
    tokensIn: number;
    tokensOut: number;
    ownCostCents: number;
  }>,
  usages: UsageAccountingRow[]
): Map<string, DurableAccounting> {
  const usageByAgent = new Map<string, DurableAccounting>();
  for (const usage of usages) {
    const hasCheckpoint =
      usage.tokenCountCheckpoint !== null &&
      usage.tokensInCheckpoint !== null &&
      usage.tokensOutCheckpoint !== null &&
      usage.ownCostCheckpointCents !== null;
    const hasLegacyUsage = usage.legacyLlmItems > 0n;
    usageByAgent.set(usage.agentId, {
      tokenCount: hasCheckpoint ? usage.tokenCountCheckpoint! : Number(usage.legacyTokenCount),
      tokensIn: hasCheckpoint ? usage.tokensInCheckpoint! : Number(usage.legacyTokensIn),
      tokensOut: hasCheckpoint ? usage.tokensOutCheckpoint! : Number(usage.legacyTokensOut),
      ownCostCents: hasCheckpoint ? usage.ownCostCheckpointCents! : usage.legacyOwnCostCents,
      hasLlmUsage: hasCheckpoint || hasLegacyUsage,
      hasCheckpoint,
    });
  }

  return new Map(
    rows.map((row) => {
      const usage = usageByAgent.get(row.id);
      return [
        row.id,
        {
          // tokenCount and ownCostCents were always own-agent DB fields.
          // Historical tokensIn/tokensOut were sometimes subtree counters, so
          // use the durable billed ledger (or a new cumulative checkpoint) when
          // it exists instead of blindly taking a maximum and double-counting
          // descendants.
          tokenCount: Math.max(row.tokenCount, usage?.tokenCount ?? 0),
          tokensIn: usage?.hasLlmUsage === true ? usage.tokensIn : row.tokensIn,
          tokensOut: usage?.hasLlmUsage === true ? usage.tokensOut : row.tokensOut,
          ownCostCents: Math.max(row.ownCostCents, usage?.ownCostCents ?? 0),
          hasLlmUsage: usage?.hasLlmUsage === true,
          hasCheckpoint: usage?.hasCheckpoint === true,
        },
      ];
    })
  );
}

function descendantSubtreeAccounting(
  descendants: DescendantAccountingRow[],
  ownAccounting: Map<string, DurableAccounting>
): Map<string, DurableAccounting> {
  const childrenByParent = new Map<string, DescendantAccountingRow[]>();
  for (const descendant of descendants) {
    const children = childrenByParent.get(descendant.parentAgentId) ?? [];
    children.push(descendant);
    childrenByParent.set(descendant.parentAgentId, children);
  }
  const totals = new Map<string, DurableAccounting>();
  for (const descendant of descendants.slice().sort((left, right) => right.depth - left.depth)) {
    const own = ownAccounting.get(descendant.id)!;
    const children = childrenByParent.get(descendant.id) ?? [];
    const childTotals = children.map((child) => totals.get(child.id)!);
    const childTokensIn = childTotals.reduce((sum, child) => sum + child.tokensIn, 0);
    const childTokensOut = childTotals.reduce((sum, child) => sum + child.tokensOut, 0);
    if (
      !own.hasLlmUsage &&
      !['COST_LIMIT_REACHED', 'OUT_OF_CREDITS', 'COMPLETED', 'FAILED'].includes(descendant.status)
    ) {
      own.tokensIn = Math.max(0, descendant.tokensIn - childTokensIn);
      own.tokensOut = Math.max(0, descendant.tokensOut - childTokensOut);
    }
    totals.set(descendant.id, {
      tokenCount: own.tokenCount + childTotals.reduce((sum, child) => sum + child.tokenCount, 0),
      tokensIn: Math.max(descendant.tokensIn, own.tokensIn + childTokensIn),
      tokensOut: Math.max(descendant.tokensOut, own.tokensOut + childTokensOut),
      ownCostCents:
        own.ownCostCents + childTotals.reduce((sum, child) => sum + child.ownCostCents, 0),
      hasLlmUsage: own.hasLlmUsage,
      hasCheckpoint: own.hasCheckpoint,
    });
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
        child.status,
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
        child.status,
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
  const [terminalChildToolCounts, toolUsages] = await Promise.all([
    descendants.length === 0
      ? Promise.resolve([])
      : tx.$queryRaw<Array<{ toolName: string; count: bigint }>>(Prisma.sql`
          WITH terminal_calls AS (
            SELECT DISTINCT ON (
              message."agentId",
              COALESCE(
                message."workflowGeneration",
                message.metadata->>'workflowGeneration',
                message."agentId"
              ),
              message.metadata->>'toolCallId'
            )
              message.metadata->>'toolName' AS "toolName"
            FROM "Message" message
            WHERE message."agentId" IN (${Prisma.join(
              descendants.map((descendant) => descendant.id)
            )})
              AND message.role = 'TOOL'::"MessageRole"
              AND message.metadata->>'toolStatus' = 'FINISHED'
              AND message.metadata->>'toolCallId' IS NOT NULL
              AND message.metadata->>'toolName' IS NOT NULL
              AND COALESCE(message.metadata->>'verifierMessage', 'false') <> 'true'
              AND message.metadata->>'toolName' NOT IN (${Prisma.join([
                ...EXCLUDED_CHILD_TOOL_COUNTS,
              ])})
            ORDER BY
              message."agentId",
              COALESCE(
                message."workflowGeneration",
                message.metadata->>'workflowGeneration',
                message."agentId"
              ),
              message.metadata->>'toolCallId',
              message."createdAt" DESC,
              message.id DESC
          )
          SELECT "toolName", COUNT(*)::bigint AS count
          FROM terminal_calls
          GROUP BY "toolName"
        `),
    tx.$queryRaw<UsageAccountingRow[]>(Prisma.sql`
      WITH llm_usage AS (
        SELECT
          usage."agentId",
          usage."tokenCountCheckpoint",
          usage."tokensInCheckpoint",
          usage."tokensOutCheckpoint",
          usage."ownCostCheckpointCents",
          item
        FROM "ToolUsage" usage
        LEFT JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(usage."usageItems") = 'array' THEN usage."usageItems"
            ELSE '[]'::jsonb
          END
        ) item ON true
        WHERE usage."agentId" IN (${Prisma.join(accountingAgentIds)})
      )
      SELECT
        "agentId",
        COALESCE(SUM(
          CASE
            WHEN "tokenCountCheckpoint" IS NULL
              AND item->>'type' = 'llm'
              AND item->>'tokens_in' ~ '^[0-9]+$'
            THEN (item->>'tokens_in')::bigint
            ELSE 0
          END
          +
          CASE
            WHEN "tokenCountCheckpoint" IS NULL
              AND item->>'type' = 'llm'
              AND item->>'tokens_out' ~ '^[0-9]+$'
            THEN (item->>'tokens_out')::bigint
            ELSE 0
          END
        ), 0)::bigint AS "legacyTokenCount",
        COALESCE(SUM(
          CASE
            WHEN "tokensInCheckpoint" IS NULL
              AND item->>'type' = 'llm'
              AND item->>'tokens_in' ~ '^[0-9]+$'
            THEN (item->>'tokens_in')::bigint
            ELSE 0
          END
        ), 0)::bigint AS "legacyTokensIn",
        COALESCE(SUM(
          CASE
            WHEN "tokensOutCheckpoint" IS NULL
              AND item->>'type' = 'llm'
              AND item->>'tokens_out' ~ '^[0-9]+$'
            THEN (item->>'tokens_out')::bigint
            ELSE 0
          END
        ), 0)::bigint AS "legacyTokensOut",
        COALESCE(SUM(
          CASE
            WHEN "ownCostCheckpointCents" IS NULL
              AND item->>'type' = 'llm'
              AND item->>'cost_cents' ~ '^[0-9]+([.][0-9]+)?$'
            THEN (item->>'cost_cents')::double precision
            ELSE 0
          END
        ), 0)::double precision AS "legacyOwnCostCents",
        COUNT(*) FILTER (
          WHERE "tokenCountCheckpoint" IS NULL AND item->>'type' = 'llm'
        )::bigint AS "legacyLlmItems",
        MAX("tokenCountCheckpoint") AS "tokenCountCheckpoint",
        MAX("tokensInCheckpoint") AS "tokensInCheckpoint",
        MAX("tokensOutCheckpoint") AS "tokensOutCheckpoint",
        MAX("ownCostCheckpointCents") AS "ownCostCheckpointCents"
      FROM llm_usage
      GROUP BY "agentId"
    `),
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
  if (
    !rootAccounting.hasLlmUsage &&
    !['COST_LIMIT_REACHED', 'OUT_OF_CREDITS', 'COMPLETED', 'FAILED'].includes(agent.status)
  ) {
    rootAccounting.tokensIn = Math.max(0, agent.tokensIn - childTokensIn);
    rootAccounting.tokensOut = Math.max(0, agent.tokensOut - childTokensOut);
  }

  return {
    version: 1,
    kind: 'deployment',
    prior_status: agent.status,
    prior_status_message: agent.statusMessage,
    progress: agent.progress,
    token_count: rootAccounting.tokenCount,
    tokens_in: rootAccounting.tokensIn,
    tokens_out: rootAccounting.tokensOut,
    tree_tokens_in: Math.max(agent.tokensIn, rootAccounting.tokensIn + childTokensIn),
    tree_tokens_out: Math.max(agent.tokensOut, rootAccounting.tokensOut + childTokensOut),
    context_size: agent.contextSize,
    message_count: agent.messageCount,
    workflow_started_at: agent.createdAt.toISOString(),
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
    child_tool_counts: Object.fromEntries(
      terminalChildToolCounts.map((row) => [row.toolName, Number(row.count)])
    ),
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

    const savedClaim =
      agent.workflowReplacementToken === null
        ? null
        : savedResumeState(agent.workflowReplacementState);
    const rotatesPriorDeployment =
      savedClaim !== null &&
      options?.deploymentAttempt !== undefined &&
      savedClaim.deployment_attempt !== options.deploymentAttempt;
    const failedSameDeployment =
      agent.status === 'FAILED' &&
      savedClaim !== null &&
      options?.deploymentAttempt !== undefined &&
      savedClaim.deployment_attempt === options.deploymentAttempt;

    if (failedSameDeployment) {
      throw new Error(
        `Existing workflow replacement candidate failed before durable readiness for deployment attempt ${options.deploymentAttempt}`
      );
    }

    if (
      options !== undefined &&
      (agent.deletedAt !== null ||
        agent.status === 'COMPLETED' ||
        (agent.status === 'FAILED' && !rotatesPriorDeployment))
    ) {
      return {
        skipped: true,
        expectedWorkflowId: options.expectedWorkflowId,
        currentWorkflowId: agent.temporalWorkflowId,
        frozenWorkflowId: agent.staleTemporalWorkflowId,
      };
    }

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

    if (agent.workflowReplacementToken !== null && !rotatesPriorDeployment) {
      if (agent.temporalWorkflowId === null) {
        throw new Error(`Agent ${agentId} has an incomplete workflow replacement claim`);
      }
      return {
        agentId,
        token: agent.workflowReplacementToken,
        plannedWorkflowId: agent.temporalWorkflowId,
        staleWorkflowId: agent.staleTemporalWorkflowId,
        staleFirstExecutionRunId: agent.staleTemporalFirstExecutionRunId,
        resumeState: savedClaim!,
      };
    }

    if (rotatesPriorDeployment) {
      if (agent.temporalWorkflowId === null || savedClaim === null) {
        throw new Error(`Agent ${agentId} has an incomplete workflow replacement claim`);
      }
      const token = randomUUID();
      const plannedWorkflowId = `${agentId}:replacement:${token}`;
      const resumeState = {
        ...savedClaim,
        deployment_attempt: options!.deploymentAttempt,
      };
      const updated = await tx.agent.update({
        where: { id: agentId },
        data: {
          workflowReplacementToken: token,
          workflowReplacementState: resumeState as unknown as Prisma.InputJsonObject,
          staleTemporalWorkflowId: agent.temporalWorkflowId,
          staleTemporalFirstExecutionRunId: agent.temporalFirstExecutionRunId,
          temporalWorkflowId: plannedWorkflowId,
          temporalFirstExecutionRunId: null,
          toolsInUse: [],
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
    }

    const builtResumeState = await buildResumeState(tx, agent, historicalLaunchConfig);
    const resumeState =
      options?.deploymentAttempt === undefined
        ? builtResumeState
        : { ...builtResumeState, deployment_attempt: options.deploymentAttempt };
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
        toolsInUse: [],
        status: 'STARTING_UP',
        userControlPaused:
          agent.userControlPaused && !['COMPLETED', 'FAILED'].includes(agent.status),
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
    const rebuiltResumeState: WorkflowResumeState =
      agent.status === 'STARTING_UP'
        ? {
            ...rebuilt,
            prior_status: previous.prior_status,
            prior_status_message: previous.prior_status_message,
          }
        : rebuilt;
    const resumeState: WorkflowResumeState =
      previous.deployment_attempt === undefined
        ? rebuiltResumeState
        : { ...rebuiltResumeState, deployment_attempt: previous.deployment_attempt };
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
