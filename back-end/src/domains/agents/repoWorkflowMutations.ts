import type { Prisma } from './types';
import { runTransactionWithRetry } from '../../providers/database';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';

/** Update worker-owned fields only while the producing workflow is still current. */
export async function updateAgentForWorkflow(
  agentId: string,
  workflowGeneration: string | undefined,
  data: Prisma.AgentUpdateManyMutationInput
) {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const requestedIterationOffset =
      typeof data.workflowIterationOffset === 'number' ? data.workflowIterationOffset : null;
    const requestedStatus = typeof data.status === 'string' ? data.status : data.status?.set;
    const updateData = { ...data };
    delete updateData.workflowIterationOffset;
    const workflowMatches: Prisma.AgentWhereInput[] =
      workflowGeneration === undefined ? [] : [{ temporalWorkflowId: workflowGeneration }];
    // A brand-new legacy workflow uses agentId as its Workflow ID and can report
    // STARTING_UP before the creator stores that ID. Replacement generations are
    // preclaimed, so they must never use this null compatibility path.
    if (workflowGeneration === agentId) workflowMatches.push({ temporalWorkflowId: null });
    const result = await tx.agent.updateMany({
      where: {
        id: agentId,
        ...(workflowGeneration === undefined ? {} : { deletedAt: null, OR: workflowMatches }),
        ...(['ACTIVE', 'STARTING_UP', 'PAUSED'].includes(String(requestedStatus))
          ? { status: { notIn: ['COMPLETED', 'FAILED'] } }
          : {}),
        // A queued worker report cannot revoke accepted user control. Explicit
        // resume clears this intent under the same lock before reporting.
        ...(requestedStatus === 'ACTIVE' || requestedStatus === 'STARTING_UP'
          ? { userControlPaused: false }
          : {}),
      },
      data: {
        ...updateData,
        ...(requestedStatus === 'COMPLETED' || requestedStatus === 'FAILED'
          ? { userControlPaused: false }
          : {}),
      },
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
    return {
      accepted: result.count === 1,
      agent: await tx.agent.findUnique({ where: { id: agentId } }),
    };
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
  workflowGeneration?: string,
  generatedTitle?: string
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
      select: {
        id: true,
        status: true,
        workflowReplacementState: true,
        title: true,
        parentAgentId: true,
      },
    });
    if (accepted === null) return false;

    const generatedTitleUpdate =
      generatedTitle !== undefined && accepted.title === null && accepted.parentAgentId === null
        ? { title: generatedTitle }
        : {};
    if (Object.keys(data).length > 0 || Object.keys(generatedTitleUpdate).length > 0) {
      const raisedCostLimit =
        (accepted.status === 'COST_LIMIT_REACHED' ||
          (accepted.status === 'STARTING_UP' &&
            accepted.workflowReplacementState !== null &&
            typeof accepted.workflowReplacementState === 'object' &&
            !Array.isArray(accepted.workflowReplacementState) &&
            accepted.workflowReplacementState.prior_status === 'COST_LIMIT_REACHED')) &&
        typeof data.priceLimitCents === 'number';
      await tx.agent.update({
        where: { id: agentId },
        data: {
          ...data,
          ...generatedTitleUpdate,
          ...(raisedCostLimit
            ? {
                status: 'ACTIVE',
                statusMessage: 'Cost limit increased',
                userControlPaused: false,
                userControlRevision: { increment: 1 },
              }
            : {}),
        },
      });
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
      select: {
        status: true,
        temporalWorkflowId: true,
        userControlRevision: true,
        updatedAt: true,
      },
    });
    if (current === null) return null;
    if (current.status === 'COMPLETED' || current.status === 'FAILED') {
      return { ...current, paused: false as const };
    }
    const updated = await tx.agent.update({
      where: { id: agentId },
      data: { status: 'PAUSED', userControlPaused: true, userControlRevision: { increment: 1 } },
      select: {
        status: true,
        temporalWorkflowId: true,
        userControlRevision: true,
        updatedAt: true,
      },
    });
    return { ...updated, paused: true as const };
  });
}
