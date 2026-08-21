import type { AgentStatus } from '@prisma/client';
import { prisma } from '../../providers/database';

/** Update an agent's fields. */
export async function updateAgent(agentId: string, data: Record<string, unknown>) {
  return prisma.agent.update({
    where: { id: agentId },
    data,
  });
}

/** Mark an agent as FAILED only if it's still in a pre-terminal, non-paused state. */
export async function failAgentIfStillActive(agentId: string, statusMessage: string) {
  return prisma.agent.updateMany({
    where: {
      id: agentId,
      status: { in: ['STARTING_UP', 'ACTIVE'] },
    },
    data: { status: 'FAILED', statusMessage },
  });
}

/** Reactivate a terminal agent only if its observed status and workflow still match. */
export async function clearWorkflowForTerminalAgent(
  agentId: string,
  observedStatus: AgentStatus,
  observedWorkflowId: string,
  _observedFirstExecutionRunId: string | null
) {
  return prisma.agent.updateMany({
    where: {
      id: agentId,
      status: observedStatus,
      temporalWorkflowId: observedWorkflowId,
    },
    data: {
      temporalWorkflowId: null,
      temporalFirstExecutionRunId: null,
      status: 'ACTIVE',
    },
  });
}

export async function softDeleteAgent(agentId: string) {
  return prisma.agent.update({
    where: { id: agentId },
    data: { deletedAt: new Date() },
  });
}

/**
 * Clear `deletedAt` on an archived agent and every archived descendant, undoing
 * what deleteAgentRecursive marked. Bounded by the subtree, so cost tracks the
 * one tree being restored rather than the account's agent count.
 *
 * The run itself is NOT resumed: archiving terminated the Temporal workflow and
 * tore down browser/sandbox sessions, so a restored agent comes back readable
 * and stopped.
 */
export async function restoreAgentAndDescendants(agentId: string) {
  return prisma.$executeRaw`
    WITH RECURSIVE descendants AS (
      SELECT id FROM "Agent" WHERE id = ${agentId} AND "deletedAt" IS NOT NULL
      UNION ALL
      SELECT a.id FROM "Agent" a
      JOIN descendants d ON a."parentAgentId" = d.id
      WHERE a."deletedAt" IS NOT NULL
    )
    UPDATE "Agent" SET "deletedAt" = NULL
    WHERE id IN (SELECT id FROM descendants)
  `;
}

/** Look up an archived (soft-deleted) agent, optionally scoped to an owner. */
export async function findArchivedAgent(agentId: string, userId?: string) {
  return prisma.agent.findFirst({
    where: {
      id: agentId,
      deletedAt: { not: null },
      ...(userId === undefined ? {} : { userId }),
    },
    select: { id: true },
  });
}

export async function deleteAttentionRequests(agentId: string) {
  return prisma.agentAttentionRequest.deleteMany({
    where: { agentId },
  });
}

export async function createGithubRepoAccess(userId: string, repoUrl: string) {
  return prisma.githubRepoAccess.create({
    data: { userId, repoUrl },
  });
}

export async function deleteAgentTools(agentId: string) {
  return prisma.agentTool.deleteMany({
    where: { agentId },
  });
}

export async function createAgentTools(agentId: string, toolIds: string[]) {
  return prisma.agentTool.createMany({
    data: toolIds.map((toolId) => ({
      agentId,
      toolId,
    })),
  });
}

/** Replace tool assignments atomically. */
export async function replaceAgentTools(agentId: string, toolIds: string[]) {
  return prisma.$transaction(async (tx) => {
    await tx.agentTool.deleteMany({ where: { agentId } });
    await tx.agentTool.createMany({
      data: toolIds.map((toolId) => ({ agentId, toolId })),
    });
  });
}
