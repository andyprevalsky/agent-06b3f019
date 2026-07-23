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
