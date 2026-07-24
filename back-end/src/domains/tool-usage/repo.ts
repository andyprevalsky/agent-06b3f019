/**
 * Tool-usage domain repo — all Prisma calls for tool usage tracking.
 */

import type { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';

/**
 * Find an agent by ID, returning only id and userId.
 */
export async function findAgentById(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, userId: true },
  });
}

/** Create usage only for the workflow generation that still owns the agent. */
export async function createToolUsageForWorkflow(params: {
  userId: string;
  agentId: string;
  workflowGeneration: string | undefined;
  toolName: string;
  totalCostCents: number;
  usageItems: Prisma.InputJsonValue;
  operationKey: string | undefined;
  accountingCheckpoint:
    | {
        token_count: number;
        tokens_in: number;
        tokens_out: number;
        own_cost_cents: number;
      }
    | undefined;
  maxLlmIteration: number | null;
}) {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, params.agentId);
    const agent = await tx.agent.findUnique({
      where: { id: params.agentId },
      select: {
        id: true,
        userId: true,
        temporalWorkflowId: true,
      },
    });
    if (agent === null) return { status: 'agent_not_found' as const };
    if (agent.userId !== params.userId) return { status: 'ownership_mismatch' as const };

    const generationMatches =
      params.workflowGeneration !== undefined &&
      (agent.temporalWorkflowId === params.workflowGeneration ||
        (params.workflowGeneration === params.agentId && agent.temporalWorkflowId === null));
    if (!generationMatches) return { status: 'stale_generation' as const };

    const data = {
      userId: params.userId,
      agentId: params.agentId,
      toolName: params.toolName,
      totalCostCents: params.totalCostCents,
      usageItems: params.usageItems,
      operationKey: params.operationKey,
      tokenCountCheckpoint: params.accountingCheckpoint?.token_count,
      tokensInCheckpoint: params.accountingCheckpoint?.tokens_in,
      tokensOutCheckpoint: params.accountingCheckpoint?.tokens_out,
      ownCostCheckpointCents: params.accountingCheckpoint?.own_cost_cents,
    };
    const toolUsage =
      params.operationKey === undefined
        ? await tx.toolUsage.create({ data })
        : await tx.toolUsage.upsert({
            where: { operationKey: params.operationKey },
            create: data,
            update: {},
          });
    if (
      toolUsage.agentId !== params.agentId ||
      toolUsage.userId !== params.userId ||
      toolUsage.toolName !== params.toolName
    ) {
      throw new Error('Tool usage operation key conflicts with a different durable operation');
    }
    if (params.maxLlmIteration !== null) {
      await tx.agent.updateMany({
        where: {
          id: params.agentId,
          workflowIterationOffset: { lt: params.maxLlmIteration },
        },
        data: { workflowIterationOffset: params.maxLlmIteration },
      });
    }
    return { status: 'created' as const, toolUsage };
  });
}

/**
 * Get all tool usage records for an agent, ordered by creation time ascending.
 */
export async function findToolUsagesByAgentId(agentId: string) {
  return prisma.toolUsage.findMany({
    where: { agentId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Find an agent by ID returning id, userId, and busId (for tree lookups).
 */
export async function findAgentWithBusId(agentId: string) {
  return prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, userId: true, busId: true },
  });
}

/**
 * Find all agent IDs that share the same busId (i.e. the whole sub-agent tree).
 */
export async function findAgentIdsByBusId(busId: string) {
  const agents = await prisma.agent.findMany({
    where: { busId },
    select: { id: true },
  });
  return agents.map((a) => a.id);
}

/**
 * Get all tool usage records for multiple agents, ordered by creation time ascending.
 */
export async function findToolUsagesByAgentIds(agentIds: string[]) {
  return prisma.toolUsage.findMany({
    where: { agentId: { in: agentIds } },
    orderBy: { createdAt: 'asc' },
  });
}
