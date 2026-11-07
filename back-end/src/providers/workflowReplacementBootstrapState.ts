import { Prisma, type AgentStatus } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import type { TemporalWorkflowExecutionRef } from './temporal';
import { lockAgentWorkflowGeneration } from './workflowGeneration';
import type { WorkflowReplacementClaim } from './workflowReplacementState';

export type WorkflowReplacementBootstrapAcknowledgement =
  'acknowledged' | 'already_acknowledged' | 'not_found' | 'stale_generation';

export interface WorkflowReplacementBootstrapState {
  status: AgentStatus;
  statusMessage?: string;
  progress: number;
  tokenCount: number;
  tokensIn: number;
  tokensOut: number;
  contextSize: number;
  messageCount: number;
  iterationOffset?: number;
}

/**
 * Persist Temporal's acceptance without consuming the recovery snapshot.
 * A worker can remain unscheduled or fail its first task after this returns.
 */
export async function recordWorkflowReplacementStartAcceptance(
  claim: WorkflowReplacementClaim,
  execution: TemporalWorkflowExecutionRef
): Promise<boolean> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, claim.agentId);
    const result = await tx.agent.updateMany({
      where: {
        id: claim.agentId,
        temporalWorkflowId: claim.plannedWorkflowId,
        deletedAt: null,
        status: { notIn: ['COMPLETED', 'FAILED'] },
      },
      data: {
        temporalWorkflowId: execution.workflowId,
        temporalFirstExecutionRunId: execution.firstExecutionRunId,
      },
    });
    if (result.count === 1) return true;

    // Temporal accepted this execution after a newer DB generation won.
    // Preserve an exact cleanup obligation before reporting the stale start.
    const agentExists = await tx.agent.count({ where: { id: claim.agentId } });
    if (agentExists === 1) {
      await tx.temporalWorkflowCleanup.upsert({
        where: {
          agentId_workflowId: {
            agentId: claim.agentId,
            workflowId: execution.workflowId,
          },
        },
        create: {
          agentId: claim.agentId,
          workflowId: execution.workflowId,
          firstExecutionRunId: execution.firstExecutionRunId,
          notBefore: new Date(),
        },
        update: {
          firstExecutionRunId: execution.firstExecutionRunId,
          notBefore: new Date(),
        },
      });
      await tx.agent.update({
        where: { id: claim.agentId },
        data: { temporalCleanupPending: true },
      });
    }
    return false;
  });
}

/**
 * Consume a replacement claim only after the candidate worker restored its
 * snapshot and reached the explicit bootstrap acknowledgement activity.
 */
export async function finalizeWorkflowReplacementBootstrap(
  agentId: string,
  workflowGeneration: string,
  restoredState?: WorkflowReplacementBootstrapState
): Promise<{
  outcome: WorkflowReplacementBootstrapAcknowledgement;
  status: AgentStatus | null;
}> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const agent = await tx.agent.findUnique({
      where: { id: agentId },
      select: {
        temporalWorkflowId: true,
        workflowReplacementToken: true,
        status: true,
        userControlPaused: true,
        statusMessage: true,
        tokenCount: true,
        tokensIn: true,
        tokensOut: true,
        messageCount: true,
        workflowIterationOffset: true,
      },
    });
    if (agent === null) return { outcome: 'not_found', status: null };
    if (agent.temporalWorkflowId !== workflowGeneration) {
      return { outcome: 'stale_generation', status: agent.status };
    }
    if (agent.workflowReplacementToken === null) {
      return { outcome: 'already_acknowledged', status: agent.status };
    }

    const terminal = agent.status === 'COMPLETED' || agent.status === 'FAILED';
    const userPaused = agent.userControlPaused && !terminal;
    const controlStateWon = userPaused || agent.status !== 'STARTING_UP';
    const finalStatus = userPaused
      ? 'PAUSED'
      : controlStateWon
        ? agent.status
        : (restoredState?.status ?? agent.status);
    const result = await tx.agent.updateMany({
      where: {
        id: agentId,
        temporalWorkflowId: workflowGeneration,
        workflowReplacementToken: agent.workflowReplacementToken,
      },
      data: {
        ...(restoredState === undefined
          ? {}
          : {
              status: finalStatus,
              statusMessage: controlStateWon
                ? agent.statusMessage
                : (restoredState.statusMessage ?? null),
              progress: restoredState.progress,
              tokenCount: Math.max(agent.tokenCount, restoredState.tokenCount),
              tokensIn: Math.max(agent.tokensIn, restoredState.tokensIn),
              tokensOut: Math.max(agent.tokensOut, restoredState.tokensOut),
              contextSize: restoredState.contextSize,
              messageCount: Math.max(agent.messageCount, restoredState.messageCount),
              workflowIterationOffset: Math.max(
                agent.workflowIterationOffset,
                restoredState.iterationOffset ?? 0
              ),
            }),
        ...(userPaused ? { status: 'PAUSED' } : {}),
        ...(terminal ? { userControlPaused: false } : {}),
        workflowReplacementToken: null,
        workflowReplacementState: Prisma.DbNull,
        staleTemporalWorkflowId: null,
        staleTemporalFirstExecutionRunId: null,
      },
    });
    return {
      outcome: result.count === 1 ? 'acknowledged' : 'stale_generation',
      status: finalStatus,
    };
  });
}

export async function acknowledgeWorkflowReplacementBootstrap(
  agentId: string,
  workflowGeneration: string
): Promise<WorkflowReplacementBootstrapAcknowledgement> {
  return (await finalizeWorkflowReplacementBootstrap(agentId, workflowGeneration)).outcome;
}

/** Keep the claim resumable and the old generation sealed after a failed start. */
export async function markWorkflowReplacementFailed(
  claim: WorkflowReplacementClaim,
  error: unknown
): Promise<void> {
  await prisma.agent.updateMany({
    where: {
      id: claim.agentId,
      workflowReplacementToken: claim.token,
      temporalWorkflowId: claim.plannedWorkflowId,
    },
    data: {
      statusMessage: `Workflow update failed: ${error instanceof Error ? error.message : String(error)}`,
    },
  });
}
