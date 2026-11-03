import { Prisma } from '@prisma/client';
import { runTransactionWithRetry } from '../../providers/database';
import { lockAgentWorkflowGeneration } from '../../providers/workflowGeneration';
import {
  isNewerProgressEstimate,
  type ProgressEstimate,
} from '../../providers/agentProgressEstimates';

async function readTaskEstimate(
  tx: Prisma.TransactionClient,
  agentId: string,
  workflowGeneration: string,
  taskId: string
) {
  const identity = {
    agentId,
    workflowGeneration,
    OR: ['taskId', 'task_id', 'subAgentId'].map((key) => ({
      metadata: { path: [key], equals: taskId },
    })),
  };
  const exists = await tx.message.findFirst({ where: identity, select: { id: true } });
  if (exists === null) return { outcome: 'unknown_task' as const };
  const terminal = await tx.message.findFirst({
    where: {
      AND: [
        identity,
        {
          OR: [
            { metadata: { path: ['action_type'], equals: 'task_complete' } },
            {
              AND: [
                { metadata: { path: ['toolCallId'], equals: taskId } },
                {
                  OR: [
                    { metadata: { path: ['toolStatus'], equals: 'FINISHED' } },
                    { metadata: { path: ['toolStatus'], equals: 'ERROR' } },
                  ],
                },
                { metadata: { path: ['subAgentId'], equals: Prisma.AnyNull } },
              ],
            },
          ],
        },
      ],
    },
    select: { id: true },
  });
  if (terminal !== null) return { outcome: 'terminal' as const };
  const row = await tx.agentTaskProgressEstimate.findUnique({
    where: { agentId_workflowGeneration_taskId: { agentId, workflowGeneration, taskId } },
  });
  return {
    outcome: 'ready' as const,
    estimate: (row?.estimate as unknown as ProgressEstimate) ?? null,
  };
}

/** Serialize against both generation/message locks and ordinary terminal status writes. */
export async function updateProgressEstimate(
  agentId: string,
  workflowGeneration: string,
  estimate: ProgressEstimate | null
) {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${agentId} FOR UPDATE`;
    const agent = await tx.agent.findFirst({
      where: { id: agentId, deletedAt: null },
      select: {
        id: true,
        busId: true,
        temporalWorkflowId: true,
        status: true,
        progressEstimate: true,
        progressEstimateGeneration: true,
      },
    });
    if (agent === null) return { outcome: 'not_found' as const };
    if ((agent.temporalWorkflowId ?? agentId) !== workflowGeneration) {
      return { outcome: 'stale_generation' as const };
    }
    if (['COMPLETED', 'FAILED', 'OUT_OF_CREDITS', 'COST_LIMIT_REACHED'].includes(agent.status)) {
      return { outcome: 'terminal' as const };
    }
    if (estimate === null) return { outcome: 'unchanged' as const };
    const taskId = estimate.taskId;
    let previous =
      agent.progressEstimateGeneration === workflowGeneration
        ? (agent.progressEstimate as unknown as ProgressEstimate | null)
        : null;
    if (taskId !== undefined) {
      const task = await readTaskEstimate(tx, agentId, workflowGeneration, taskId);
      if (task.outcome !== 'ready') return task;
      previous = task.estimate;
    }
    if (!isNewerProgressEstimate(previous, estimate)) return { outcome: 'unchanged' as const };
    let updatedAt: Date;
    if (taskId === undefined) {
      const snapshot = await tx.agent.update({
        where: { id: agentId },
        data: { progressEstimate: { ...estimate }, progressEstimateGeneration: workflowGeneration },
        select: { updatedAt: true },
      });
      updatedAt = snapshot.updatedAt;
    } else {
      await tx.agentTaskProgressEstimate.upsert({
        where: { agentId_workflowGeneration_taskId: { agentId, workflowGeneration, taskId } },
        create: { agentId, workflowGeneration, taskId, estimate: { ...estimate } },
        update: { estimate: { ...estimate } },
      });
      const snapshot = await tx.agent.update({
        where: { id: agentId },
        data: { updatedAt: new Date() },
        select: { updatedAt: true },
      });
      updatedAt = snapshot.updatedAt;
    }
    return { outcome: 'updated' as const, estimate, updatedAt, busId: agent.busId ?? agentId };
  });
}
