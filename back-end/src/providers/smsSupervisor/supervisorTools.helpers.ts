/**
 * Shared helpers for the SMS supervisor tool dispatcher.
 *
 * Lives in a sibling file to keep supervisorTools.ts under the project-wide
 * max-lines limit. Both validate-side prefix resolution and commit-side
 * recursive deletion are pure DB/Temporal operations with no tool-specific
 * logic, so they sit comfortably here.
 */

import { prisma } from '../database';
import { createLogger } from '../logger';
import type { PendingOp } from './supervisorTools';

const log = createLogger('SmsSupervisorTools');

export function unknownSupervisorToolError(tool: string): string {
  if (tool === 'spawn_agent') {
    return 'Unknown tool: spawn_agent. On the SMS surface use start_new_agent (and kill_agent) — spawn_agent is the main-agent tool, not available here.';
  }
  return `Unknown tool: ${tool}`;
}

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
 * Resolve a write-tool target, including an agent this run queued with
 * start_new_agent. The queued result advertises its provisional id, the start
 * commit creates the row with exactly that id, and pending writes commit in
 * order, so a write queued against it lands after the agent exists.
 */
export async function resolveAgentTarget(
  prefixOrId: string,
  userId: string,
  pendingWrites: readonly PendingOp[]
): Promise<{ id: string } | null> {
  const input = prefixOrId.trim();
  const queued =
    input.length > 0
      ? pendingWrites.find(
          (op): op is Extract<PendingOp, { kind: 'start_new_agent' }> =>
            op.kind === 'start_new_agent' && op.provisionalId.startsWith(input)
        )
      : undefined;
  if (queued) return { id: queued.provisionalId };
  const agent = await resolveAgentPrefix(input, userId);
  return agent ? { id: agent.id } : null;
}
