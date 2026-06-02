/**
 * Shared agent resume primitive for domain services that need to unblock a workflow.
 */

import { prisma } from './database';
import { getTemporalClient } from './temporal';
import { createLogger } from './logger';

const log = createLogger('AgentResume');

export async function resumeAgentWorkflow(agentId: string): Promise<void> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { temporalWorkflowId: true },
  });

  if (!agent) return;

  await prisma.agent.update({
    where: { id: agentId },
    data: { status: 'ACTIVE' },
  });

  /* c8 ignore start -- Temporal signal requires live Temporal server */
  if (agent.temporalWorkflowId !== null) {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.signal('resume');
    } catch (error) {
      log.warn('Resume signal failed, DB updated. Workflow will sync next iteration', {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  /* c8 ignore stop */
}
