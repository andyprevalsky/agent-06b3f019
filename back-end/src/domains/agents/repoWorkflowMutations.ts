import type { Prisma } from '@prisma/client';
import { runTransactionWithRetry } from '../../providers/database';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';

/** Update worker-owned fields only while the producing workflow is still current. */
export async function updateAgentForWorkflow(
  agentId: string,
  workflowGeneration: string,
  data: Prisma.AgentUpdateManyMutationInput
) {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const requestedIterationOffset =
      typeof data.workflowIterationOffset === 'number' ? data.workflowIterationOffset : null;
    const updateData = { ...data };
    delete updateData.workflowIterationOffset;
    const workflowMatches: Prisma.AgentWhereInput[] = [{ temporalWorkflowId: workflowGeneration }];
    // A brand-new legacy workflow uses agentId as its Workflow ID and can report
    // STARTING_UP before the creator stores that ID. Replacement generations are
    // preclaimed, so they must never use this null compatibility path.
    if (workflowGeneration === agentId) workflowMatches.push({ temporalWorkflowId: null });
    const result = await tx.agent.updateMany({
      where: {
        id: agentId,
        deletedAt: null,
        OR: workflowMatches,
      },
      data: updateData,
    });
    if (result.count === 1 && requestedIterationOffset !== null) {
      await tx.$executeRaw`
        UPDATE "Agent"
        SET "workflowIterationOffset" = GREATEST(
          "workflowIterationOffset",
          ${requestedIterationOffset}
        )
        WHERE id = ${agentId}
      `;
    }
    return result.count === 1;
  });
}

/**
 * Apply scalar config and relational tool changes as one workflow-generation
 * mutation. Human config changes also take the advisory lock so a replacement
 * snapshot is wholly before or wholly after the mutation.
 */
export async function updateAgentConfigMutation(
  agentId: string,
  data: Prisma.AgentUpdateManyMutationInput,
  toolIds: string[] | undefined,
  workflowGeneration?: string
): Promise<boolean> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const workflowMatches: Prisma.AgentWhereInput[] =
      workflowGeneration === undefined ? [] : [{ temporalWorkflowId: workflowGeneration }];
    if (workflowGeneration === agentId) workflowMatches.push({ temporalWorkflowId: null });
    const accepted = await tx.agent.findFirst({
      where: {
        id: agentId,
        deletedAt: null,
        ...(workflowGeneration === undefined ? {} : { OR: workflowMatches }),
      },
      select: { id: true },
    });
    if (accepted === null) return false;

    if (Object.keys(data).length > 0) {
      await tx.agent.update({ where: { id: agentId }, data });
    }
    if (toolIds !== undefined) {
      await tx.agentTool.deleteMany({ where: { agentId } });
      if (toolIds.length > 0) {
        await tx.agentTool.createMany({
          data: toolIds.map((toolId) => ({ agentId, toolId })),
        });
      }
    }
    return true;
  });
}

/** Serialize a user-originated state change against workflow deployment claims. */
export async function updateAgentUnderWorkflowLock(agentId: string, data: Prisma.AgentUpdateInput) {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const found = await tx.agent.findFirst({
      where: { id: agentId, deletedAt: null },
      select: { id: true },
    });
    if (found === null) return null;
    return tx.agent.update({ where: { id: agentId }, data });
  });
}

/** Persist pause and return the workflow generation that won the same lock. */
export async function pauseAgentUnderWorkflowLock(agentId: string) {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const current = await tx.agent.findFirst({
      where: { id: agentId, deletedAt: null },
      select: { status: true, temporalWorkflowId: true },
    });
    if (current === null) return null;
    if (current.status === 'COMPLETED' || current.status === 'FAILED') {
      return { ...current, paused: false as const };
    }
    const updated = await tx.agent.update({
      where: { id: agentId },
      data: { status: 'PAUSED' },
      select: { status: true, temporalWorkflowId: true },
    });
    return { ...updated, paused: true as const };
  });
}
