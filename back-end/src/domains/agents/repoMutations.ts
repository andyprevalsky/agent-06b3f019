/**
 * Agents domain repo mutations — create, update, delete operations.
 */

import type { Prisma, AgentSource, VerifierType } from '@prisma/client';
import { prisma } from '../../providers/database';

// ---------------------------------------------------------------------------
// Agent mutations
// ---------------------------------------------------------------------------

async function createAttachmentMessages(
  tx: Prisma.TransactionClient,
  agentId: string,
  attachments: Array<Record<string, unknown>>
) {
  for (const attachment of attachments) {
    await tx.message.create({
      data: {
        agentId,
        text: '',
        role: 'USER',
        timestamp: new Date(),
        filePointer: attachment as Prisma.JsonObject,
      },
    });
  }
}

/** Create an agent with verifier and goal message in a transaction. */
export async function createAgentTransaction(params: {
  agentId: string;
  userId: string;
  parentAgentId: string | null;
  parentWorkflowId: string | null;
  depth: number;
  busId: string | null;
  goal: string;
  model: string;
  reasoningMaxTokens: number;
  source: string;
  tokenInPriceMicrodollars: number | null;
  tokenOutPriceMicrodollars: number | null;
  pauseState: boolean;
  responseSchema: unknown | undefined;
  proxyCountry: string;
  proxyState?: string;
  proxyCity?: string;
  priceLimitCents?: number;
  writeLockEnabled?: boolean;
  verifierType: string;
  attachments?: Array<Record<string, unknown>>;
  temporalWorkflowId?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const newAgent = await tx.agent.create({
      data: {
        id: params.agentId,
        userId: params.userId,
        parentAgentId: params.parentAgentId,
        parentWorkflowId: params.parentWorkflowId,
        depth: params.depth,
        busId: params.busId,
        goal: params.goal,
        model: params.model,
        reasoningMaxTokens: params.reasoningMaxTokens,
        source: params.source as AgentSource,
        tokenInPriceMicrodollars: params.tokenInPriceMicrodollars,
        tokenOutPriceMicrodollars: params.tokenOutPriceMicrodollars,
        progress: 0.0,
        status: params.pauseState ? 'PAUSED' : 'STARTING_UP',
        responseSchema: params.responseSchema ?? undefined,
        proxyCountry: params.proxyCountry,
        proxyState: params.proxyState,
        proxyCity: params.proxyCity,
        ...(params.temporalWorkflowId !== undefined && params.temporalWorkflowId !== null
          ? { temporalWorkflowId: params.temporalWorkflowId }
          : {}),
        ...(params.priceLimitCents !== undefined && params.priceLimitCents !== 0
          ? { priceLimitCents: params.priceLimitCents }
          : {}),
        ...(params.writeLockEnabled !== undefined
          ? { writeLockEnabled: params.writeLockEnabled }
          : {}),
      },
    });

    await tx.verifier.create({
      data: {
        agentId: newAgent.id,
        type: params.verifierType as VerifierType,
      },
    });

    const goalMessage = await tx.message.create({
      data: {
        agentId: newAgent.id,
        text: params.goal,
        role: 'USER',
        timestamp: new Date(),
      },
    });

    if (params.attachments !== undefined && params.attachments.length > 0) {
      await createAttachmentMessages(tx, newAgent.id, params.attachments);
    }

    return { agent: newAgent, goalMessage };
  });
}

export interface BatchCreateAgentParams {
  agentId: string;
  userId: string;
  parentAgentId: string | null;
  parentWorkflowId: string | null;
  depth: number;
  busId: string | null;
  goal: string;
  model: string;
  reasoningMaxTokens: number;
  source: string;
  tokenInPriceMicrodollars: number | null;
  tokenOutPriceMicrodollars: number | null;
  pauseState: boolean;
  responseSchema: unknown | undefined;
  proxyCountry: string;
  proxyState?: string;
  proxyCity?: string;
  priceLimitCents?: number;
  writeLockEnabled?: boolean;
  verifierType: string;
  attachments?: Array<Record<string, unknown>>;
  temporalWorkflowId: string;
}

/** Create N agents (each with verifier + goal message) in a single transaction.
 *  All-or-nothing: if any row fails to insert, the whole batch rolls back. */
export async function createAgentBatchTransaction(items: BatchCreateAgentParams[]) {
  return prisma.$transaction(async (tx) => {
    const results: Array<{ agent: Awaited<ReturnType<typeof tx.agent.create>> }> = [];
    for (const params of items) {
      const newAgent = await tx.agent.create({
        data: {
          id: params.agentId,
          userId: params.userId,
          parentAgentId: params.parentAgentId,
          parentWorkflowId: params.parentWorkflowId,
          depth: params.depth,
          busId: params.busId,
          goal: params.goal,
          model: params.model,
          reasoningMaxTokens: params.reasoningMaxTokens,
          source: params.source as AgentSource,
          tokenInPriceMicrodollars: params.tokenInPriceMicrodollars,
          tokenOutPriceMicrodollars: params.tokenOutPriceMicrodollars,
          progress: 0.0,
          status: params.pauseState ? 'PAUSED' : 'STARTING_UP',
          responseSchema: params.responseSchema ?? undefined,
          proxyCountry: params.proxyCountry,
          proxyState: params.proxyState,
          proxyCity: params.proxyCity,
          temporalWorkflowId: params.temporalWorkflowId,
          ...(params.priceLimitCents !== undefined && params.priceLimitCents !== 0
            ? { priceLimitCents: params.priceLimitCents }
            : {}),
          ...(params.writeLockEnabled !== undefined
            ? { writeLockEnabled: params.writeLockEnabled }
            : {}),
        },
      });
      await tx.verifier.create({
        data: { agentId: newAgent.id, type: params.verifierType as VerifierType },
      });
      await tx.message.create({
        data: { agentId: newAgent.id, text: params.goal, role: 'USER', timestamp: new Date() },
      });
      if (params.attachments !== undefined && params.attachments.length > 0) {
        await createAttachmentMessages(tx, newAgent.id, params.attachments);
      }
      results.push({ agent: newAgent });
    }
    return results;
  });
}

/** Update an agent's fields. */
export async function updateAgent(agentId: string, data: Record<string, unknown>) {
  return prisma.agent.update({
    where: { id: agentId },
    data,
  });
}

/** Mark an agent as FAILED only if it's still in a pre-terminal, non-paused state.
 *  Prevents background error handlers from overwriting user-initiated status changes. */
export async function failAgentIfStillActive(agentId: string, statusMessage: string) {
  return prisma.agent.updateMany({
    where: {
      id: agentId,
      status: { in: ['STARTING_UP', 'ACTIVE'] },
    },
    data: { status: 'FAILED', statusMessage },
  });
}

/** Soft-delete an agent. */
export async function softDeleteAgent(agentId: string) {
  return prisma.agent.update({
    where: { id: agentId },
    data: { deletedAt: new Date() },
  });
}

/** Delete all attention requests for an agent. */
export async function deleteAttentionRequests(agentId: string) {
  return prisma.agentAttentionRequest.deleteMany({
    where: { agentId },
  });
}

/** Create a GitHub repo access record. */
export async function createGithubRepoAccess(userId: string, repoUrl: string) {
  return prisma.githubRepoAccess.create({
    data: { userId, repoUrl },
  });
}

/** Delete all tool assignments for an agent. */
export async function deleteAgentTools(agentId: string) {
  return prisma.agentTool.deleteMany({
    where: { agentId },
  });
}

/** Create tool assignments for an agent. */
export async function createAgentTools(agentId: string, toolIds: string[]) {
  return prisma.agentTool.createMany({
    data: toolIds.map((toolId) => ({
      agentId,
      toolId,
    })),
  });
}

/** Replace tool assignments atomically — delete old, create new in one transaction. */
export async function replaceAgentTools(agentId: string, toolIds: string[]) {
  return prisma.$transaction(async (tx) => {
    await tx.agentTool.deleteMany({ where: { agentId } });
    await tx.agentTool.createMany({
      data: toolIds.map((toolId) => ({ agentId, toolId })),
    });
  });
}
