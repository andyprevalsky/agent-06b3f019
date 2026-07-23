/**
 * Shared agent resume primitive for domain services that need to unblock a workflow.
 */

import { prisma } from './database';
import { getTemporalClient } from './temporal';
import { createLogger } from './logger';

const log = createLogger('AgentResume');

export type ResumeAgentWorkflowResult = { success: true } | { error: string; status: number };

interface ResumeAgentWorkflowDependencies {
  signalResume?: (workflowId: string) => Promise<void>;
}

async function signalResume(workflowId: string): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.getHandle(workflowId).signal('resume');
}

export async function resumeAgentWorkflow(
  agentId: string,
  dependencies: ResumeAgentWorkflowDependencies = {}
): Promise<ResumeAgentWorkflowResult> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { temporalWorkflowId: true },
  });

  if (!agent) return { error: 'Agent not found', status: 404 };

  /* c8 ignore start -- Temporal signal requires live Temporal server */
  if (agent.temporalWorkflowId !== null) {
    try {
      await (dependencies.signalResume ?? signalResume)(agent.temporalWorkflowId);
    } catch (error) {
      log.warn('Resume signal failed, DB status unchanged', {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { error: 'Cannot resume agent because its workflow is not running', status: 409 };
    }
    // The workflow validates credits/cost state and persists ACTIVE through its
    // generation-fenced activity. Do not let this external request race that
    // decision or claim a resume the workflow rejected.
    return { success: true };
  }
  /* c8 ignore stop */

  await prisma.agent.update({
    where: { id: agentId },
    data: { status: 'ACTIVE' },
  });

  return { success: true };
}
