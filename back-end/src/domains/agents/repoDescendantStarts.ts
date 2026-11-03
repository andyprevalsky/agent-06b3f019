import { prisma } from '../../providers/database';

/**
 * Fetch the durable launch intent for stable-ID descendant retries. Callers
 * compare every immutable start field before resuming a pending outbox row.
 */
export async function findExistingAgentsByIds(agentIds: string[], userId: string) {
  return prisma.agent.findMany({
    where: { id: { in: agentIds }, userId },
    select: {
      id: true,
      projectId: true,
      folderId: true,
      status: true,
      statusMessage: true,
      progress: true,
      temporalWorkflowId: true,
      temporalFirstExecutionRunId: true,
      temporalWorkflowStartPending: true,
      parentAgentId: true,
      parentWorkflowId: true,
      depth: true,
      busId: true,
      createdAt: true,
      updatedAt: true,
      goal: true,
      model: true,
      source: true,
      reasoningMaxTokens: true,
      responseSchema: true,
      fastModeCacheEnabled: true,
      worldModelMode: true,
      memoryEnabled: true,
      priceLimitCents: true,
      workflowMaxIterations: true,
      workflowContextGates: true,
      workflowStartPhase: true,
      workflowTaskQueue: true,
    },
  });
}
