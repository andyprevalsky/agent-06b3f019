import type { Message, Prisma } from '@prisma/client';
import { runTransactionWithRetry } from './database';
import { createLogger } from './logger';
import type { TemporalWorkflowExecutionRef } from './temporal';

const WORKFLOW_GENERATION_LOCK_SEED = 6_901_733;
const log = createLogger('WorkflowGeneration');

export const DEPLOY_INTERRUPTED_TOOL_MESSAGE = 'new code version deployed, retry this tool';

export class StaleParentWorkflowGenerationError extends Error {
  constructor(message = 'Parent workflow generation is no longer current') {
    super(message);
    this.name = 'StaleParentWorkflowGenerationError';
  }
}

export function messageWorkflowGeneration(message: Message): string {
  return message.workflowGeneration ?? message.agentId;
}

export function incomingWorkflowGeneration(
  agentId: string,
  metadata: Record<string, unknown> | null | undefined
): string {
  const value = metadata?.workflowGeneration;
  return typeof value === 'string' && value.length > 0 ? value : agentId;
}

/** Serialize the deployment cutover against every worker lifecycle write. */
export async function lockAgentWorkflowGeneration(
  tx: Prisma.TransactionClient,
  agentId: string
): Promise<void> {
  await tx.$queryRaw`
    WITH acquired AS MATERIALIZED (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${agentId}:workflow-generation`}, ${WORKFLOW_GENERATION_LOCK_SEED})
      )
    )
    SELECT 1 AS locked FROM acquired
  `;
}

/**
 * Let independent writes in one generation proceed together while still
 * blocking behind an exclusive deployment cutover.
 */
export async function lockAgentWorkflowGenerationShared(
  tx: Prisma.TransactionClient,
  agentId: string
): Promise<void> {
  await tx.$queryRaw`
    WITH acquired AS MATERIALIZED (
      SELECT pg_advisory_xact_lock_shared(
        hashtextextended(${`${agentId}:workflow-generation`}, ${WORKFLOW_GENERATION_LOCK_SEED})
      )
    )
    SELECT 1 AS locked FROM acquired
  `;
}

/**
 * Commit a started execution's full chain identity to its agent. A root agent
 * reuses Workflow ID = agent ID for every run, so the first-execution run ID
 * is what distinguishes one generation from the next; recording only the
 * Workflow ID lets terminal cleanup mistake a follow-up run for the finished
 * one. A deployment replacement or another start that wins first remains
 * authoritative.
 */
export async function recordAgentWorkflowExecution(
  agentId: string,
  execution: TemporalWorkflowExecutionRef,
  options: { requireActive?: boolean } = {}
): Promise<boolean> {
  return runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const agent = await tx.agent.findUnique({
      where: { id: agentId },
      select: {
        deletedAt: true,
        status: true,
        temporalWorkflowId: true,
        temporalFirstExecutionRunId: true,
      },
    });
    if (
      agent === null ||
      agent.deletedAt !== null ||
      (options.requireActive === true && agent.status !== 'ACTIVE') ||
      (agent.temporalWorkflowId !== null && agent.temporalWorkflowId !== execution.workflowId) ||
      (agent.temporalFirstExecutionRunId !== null &&
        agent.temporalFirstExecutionRunId !== execution.firstExecutionRunId)
    ) {
      return false;
    }
    await tx.agent.update({
      where: { id: agentId },
      data: {
        temporalWorkflowId: execution.workflowId,
        temporalFirstExecutionRunId: execution.firstExecutionRunId,
      },
    });
    return true;
  });
}

/**
 * Bind an already-running execution to an agent row created with its Workflow
 * ID. The run is live, so a failed bind is logged, never surfaced as a failed
 * start; terminal cleanup treats an unbound run conservatively.
 */
export async function bindStartedRunIdentity(
  agentId: string,
  execution: TemporalWorkflowExecutionRef
): Promise<void> {
  try {
    if (!(await recordAgentWorkflowExecution(agentId, execution))) {
      log.warn('Started workflow was superseded before its run identity was recorded', {
        agent_id: agentId,
        workflow_id: execution.workflowId,
        first_execution_run_id: execution.firstExecutionRunId,
      });
    }
  } catch (error) {
    log.error('Failed to record started workflow run identity', {
      agent_id: agentId,
      workflow_id: execution.workflowId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Commit a chat escalation only while the agent still belongs to chat mode;
 * delayed fire-and-forget chat work may never overwrite a winning start.
 */
export async function acceptChatWorkflowExecution(
  agentId: string,
  execution: TemporalWorkflowExecutionRef
): Promise<boolean> {
  return recordAgentWorkflowExecution(agentId, execution, { requireActive: true });
}
