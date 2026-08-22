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
 *
 * Concurrency fence:
 *   Child create locks parent workflow-generation → checks deletedAt null
 *   Archive locks parent → soft-deletes → snapshots children (same tx)
 *   so a child cannot commit after the snapshot and escape cleanup.
 */

import { prisma, runTransactionWithRetry } from './database';
import { cleanupAgentSessions } from './agentCleanup';
import { getTemporalClient } from './temporal';
import { createLogger } from './logger';
import { lockAgentWorkflowGeneration } from './workflowGeneration';

const log = createLogger('AgentKill');

export interface DeleteAgentOptions {
  /** Temporal terminate reason. Defaults to the UI-archive wording. */
  terminateReason?: string;
}

interface SealedAgentKill {
  temporalWorkflowId: string | null;
  childIds: string[];
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

  // Soft-delete under the same generation lock child-create uses, then snapshot
  // children in that transaction so no late child can attach after the snapshot.
  const sealed = await runTransactionWithRetry(async (tx) => {
    await lockAgentWorkflowGeneration(tx, agentId);
    const agent = await tx.agent.findFirst({
      where: { id: agentId, deletedAt: null },
      select: {
        temporalWorkflowId: true,
        children: { where: { deletedAt: null }, select: { id: true } },
      },
    });
    if (agent === null) {
      return null;
    }
    await tx.agent.update({
      where: { id: agentId },
      data: { deletedAt: new Date() },
    });
    const result: SealedAgentKill = {
      temporalWorkflowId: agent.temporalWorkflowId,
      childIds: agent.children.map((child) => child.id),
    };
    return result;
  });
  if (sealed === null) {
    return;
  }

  for (const childId of sealed.childIds) {
    await deleteAgentRecursive(childId, options);
  }

  await cleanupAgentSessions(agentId);

  /* c8 ignore start -- Temporal termination requires live Temporal server */
  if (sealed.temporalWorkflowId !== null && sealed.temporalWorkflowId !== '') {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(sealed.temporalWorkflowId);
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
          workflow_id: sealed.temporalWorkflowId,
          reason: msg,
        });
      } else {
        log.warn('Failed to terminate workflow', {
          agent_id: agentId,
          workflow_id: sealed.temporalWorkflowId,
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

  log.info('Deleted agent', { agent_id: agentId, terminate_reason: terminateReason });
}
