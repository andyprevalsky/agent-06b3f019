/**
 * Shared helpers for the SMS supervisor tool dispatcher.
 *
 * Lives in a sibling file to keep supervisorTools.ts under the project-wide
 * max-lines limit. Both validate-side prefix resolution and commit-side
 * recursive deletion are pure DB/Temporal operations with no tool-specific
 * logic, so they sit comfortably here.
 */

import { prisma } from '../database';
import { cleanupAgentSessions } from '../agentCleanup';
import { getTemporalClient } from '../temporal';
import { createLogger } from '../logger';

const log = createLogger('SmsSupervisorTools');

/**
 * Resolve a 6-char prefix or full UUID to the user's agent row, scoped to the
 * given userId so SMS never reaches across tenants. Returns null when nothing
 * matches.
 */
export async function resolveAgentPrefix(
  prefixOrId: string,
  userId: string
): Promise<{
  id: string;
  goal: string;
  status: string;
  priceLimitCents: number;
  treeCostCents: number;
  temporalWorkflowId: string | null;
} | null> {
  const input = prefixOrId.trim();

  log.info('Resolving agent prefix', { input, userId });

  // Try exact match first (full UUID)
  if (input.length > 6) {
    const agent = await prisma.agent.findFirst({
      where: { id: input, userId, deletedAt: null },
    });
    if (agent) {
      log.info('Resolved by exact match', { agentId: agent.id });
      return agent;
    }
  }

  // Prefix match
  const agent = await prisma.agent.findFirst({
    where: {
      id: { startsWith: input },
      userId,
      deletedAt: null,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (agent) {
    log.info('Resolved by prefix', {
      prefix: input,
      agentId: agent.id,
      goal: agent.goal.substring(0, 50),
    });
  } else {
    log.info('No agent found for prefix', { prefix: input, userId });
  }

  return agent;
}

/**
 * Recursively soft-delete an agent and all its descendants. Cleans up E2B
 * sandboxes and Steel browser sessions, terminates Temporal workflows, and
 * marks rows with `deletedAt`. Idempotent: if the agent is already deleted,
 * returns without further work.
 */
export async function deleteAgentRecursive(agentId: string): Promise<void> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, deletedAt: null },
    include: { children: { where: { deletedAt: null } } },
  });

  if (!agent) return;

  for (const child of agent.children) {
    await deleteAgentRecursive(child.id);
  }

  await cleanupAgentSessions(agentId);

  if (agent.temporalWorkflowId) {
    try {
      log.info('Terminating workflow', {
        phase: 'kill',
        workflowId: agent.temporalWorkflowId,
        agentId,
      });
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.terminate('Agent killed via SMS');
    } catch (error) {
      log.warn('Failed to terminate workflow', {
        phase: 'kill',
        workflowId: agent.temporalWorkflowId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await prisma.agent.update({
    where: { id: agentId },
    data: { deletedAt: new Date() },
  });

  log.info('Deleted agent', { phase: 'kill', agentId });
}
