import { Prisma, type AgentStatus } from '@prisma/client';
import { runTransactionWithRetry } from './database';
import { lockAgentWorkflowGeneration } from './workflowGeneration';
import { savedResumeState } from './workflowReplacementResumeState';

export type WorkflowResumeIntentResult =
  | { outcome: 'not_found' }
  | { outcome: 'terminal' }
  | {
      outcome: 'ready';
      workflowId: string | null;
      userId: string;
      userControlRevision: number;
      replacementOwned: boolean;
      previousStatus: AgentStatus;
      persistedActiveIntent: boolean;
      requiresCreditCheck: boolean;
    };

export async function recordWorkflowResumeIntent(
  agentId: string,
  options: { creditsRestored?: boolean } = {}
): Promise<WorkflowResumeIntentResult> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const agent = await tx.agent.findUnique({ where: { id: agentId } });
    if (agent === null || agent.deletedAt !== null) return { outcome: 'not_found' };
    if (agent.status === 'COMPLETED' || agent.status === 'FAILED') {
      return { outcome: 'terminal' };
    }

    const replacementOwned = agent.workflowReplacementToken !== null;
    const replacementState = replacementOwned
      ? savedResumeState(agent.workflowReplacementState)
      : null;
    const resumablePause = agent.status === 'PAUSED' || replacementState?.prior_status === 'PAUSED';
    const resumableCreditPause =
      agent.status === 'OUT_OF_CREDITS' || replacementState?.prior_status === 'OUT_OF_CREDITS';
    const creditsRestored = resumableCreditPause && options.creditsRestored === true;
    if (resumablePause || creditsRestored) {
      await tx.agent.update({
        where: { id: agentId },
        data: {
          status: 'ACTIVE',
          userControlPaused: false,
          userControlRevision: { increment: 1 },
          statusMessage: 'Resume requested',
          ...(replacementState === null
            ? {}
            : {
                workflowReplacementState: {
                  ...replacementState,
                  prior_status: 'ACTIVE',
                  prior_status_message: 'Resume requested',
                } as unknown as Prisma.InputJsonObject,
              }),
        },
      });
    }
    return {
      outcome: 'ready',
      workflowId: agent.temporalWorkflowId,
      userId: agent.userId,
      userControlRevision: agent.userControlRevision + (resumablePause || creditsRestored ? 1 : 0),
      replacementOwned,
      previousStatus: agent.status,
      persistedActiveIntent: resumablePause || creditsRestored,
      requiresCreditCheck:
        replacementOwned && resumableCreditPause && options.creditsRestored !== true,
    };
  });
}

export async function rollbackWorkflowResumeIntent(
  agentId: string,
  workflowId: string,
  userControlRevision: number
): Promise<boolean> {
  if (!Number.isSafeInteger(userControlRevision) || userControlRevision < 0) return false;
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const rolledBack = await tx.agent.updateMany({
      where: {
        id: agentId,
        temporalWorkflowId: workflowId,
        userControlRevision,
        workflowReplacementToken: null,
        status: 'ACTIVE',
        statusMessage: 'Resume requested',
      },
      data: { status: 'PAUSED', userControlPaused: true, statusMessage: null },
    });
    return rolledBack.count === 1;
  });
}
