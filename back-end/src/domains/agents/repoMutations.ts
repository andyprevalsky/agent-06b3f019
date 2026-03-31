/**
 * Agents domain repo mutations — create, update, delete operations.
 */

import type { Prisma, AgentSource, VerifierType } from '@prisma/client';
import { prisma } from '../../providers/database';

// ---------------------------------------------------------------------------
// Agent mutations
// ---------------------------------------------------------------------------

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
  verifierType: string;
  verifierPrompt: string;
  attachments?: Array<Record<string, unknown>>;
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
        ...(params.priceLimitCents !== undefined && params.priceLimitCents !== 0
          ? { priceLimitCents: params.priceLimitCents }
          : {}),
      },
    });

    await tx.verifier.create({
      data: {
        agentId: newAgent.id,
        type: params.verifierType as VerifierType,
        llmJudgePrompt: params.verifierPrompt,
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
      for (const attachment of params.attachments) {
        await tx.message.create({
          data: {
            agentId: newAgent.id,
            text: '',
            role: 'USER',
            timestamp: new Date(),
            filePointer: attachment as Prisma.JsonObject,
          },
        });
      }
    }

    return { agent: newAgent, goalMessage };
  });
}

/** Update an agent's fields. */
export async function updateAgent(agentId: string, data: Record<string, unknown>) {
  return prisma.agent.update({
    where: { id: agentId },
    data,
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

/** Update a verifier's LLM judge prompt. */
export async function updateVerifierPrompt(verifierId: string, llmJudgePrompt: string) {
  return prisma.verifier.update({
    where: { id: verifierId },
    data: { llmJudgePrompt },
  });
}
