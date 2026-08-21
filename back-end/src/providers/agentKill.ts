/**
 * Canonical agent kill / archive path.
 *
 * Every soft-delete surface must call `deleteAgentRecursive` here — UI Archive
 * (`DELETE /api/agents/:id`), SMS `kill_agent`, and SMS `/clear`. Do not soft-delete
 * agents, terminate workflows, or wipe attention requests on a parallel path.
 *
 * Diagram:
 *   UI Archive ──┐
 *   SMS kill ────┼──► deleteAgentRecursive ──► sessions + Temporal + attention + deletedAt
 *   SMS /clear ──┘
 */

import { prisma } from './database';
import { cleanupAgentSessions } from './agentCleanup';
import { getTemporalClient } from './temporal';
import { createLogger } from './logger';

const log = createLogger('AgentKill');

export interface DeleteAgentOptions {
  /** Temporal terminate reason. Defaults to the UI-archive wording. */
  terminateReason?: string;
}

/**
 * Recursively soft-delete an agent and all its descendants.
 * Cleans up sessions, terminates Temporal workflows, deletes attention requests,
 * then sets `deletedAt`. Idempotent when the agent is already archived.
 */
export async function deleteAgentRecursive(
  agentId: string,
  options: DeleteAgentOptions = {}
): Promise<void> {
  const terminateReason = options.terminateReason ?? 'Agent deleted by user';

  const agent = await prisma.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    include: { children: { where: { deletedAt: null } } },
  });
  if (!agent) {
    return;
  }

  for (const child of agent.children) {
    await deleteAgentRecursive(child.id, options);
  }

  await cleanupAgentSessions(agentId);

  /* c8 ignore start -- Temporal termination requires live Temporal server */
  if (agent.temporalWorkflowId !== null && agent.temporalWorkflowId !== '') {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.terminate(terminateReason);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        msg.includes('not found') ||
        msg.includes('already completed') ||
        msg.includes('terminated')
      ) {
        log.info('No active workflow to terminate', {
          agent_id: agentId,
          workflow_id: agent.temporalWorkflowId,
          reason: msg,
        });
      } else {
        log.warn('Failed to terminate workflow', {
          agent_id: agentId,
          workflow_id: agent.temporalWorkflowId,
          error: msg,
        });
      }
    }
  } else {
    /* c8 ignore stop */
    log.info('No workflow id for agent, skipping termination', { agent_id: agentId });
  }

  await prisma.agentAttentionRequest.deleteMany({ where: { agentId } });
  // Fast Mode cache entries intentionally outlive agent deletion. They are keyed by
  // goal hash and only removed by the explicit fast-cache purge endpoint.
  await prisma.agent.update({
    where: { id: agentId },
    data: { deletedAt: new Date() },
  });

  log.info('Deleted agent', { agent_id: agentId, terminate_reason: terminateReason });
}
