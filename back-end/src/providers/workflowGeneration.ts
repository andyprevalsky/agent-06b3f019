import type { Message, Prisma } from '@prisma/client';

const WORKFLOW_GENERATION_LOCK_SEED = 6_901_733;

export const DEPLOY_INTERRUPTED_TOOL_MESSAGE = 'new code version deployed, retry this tool';

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
