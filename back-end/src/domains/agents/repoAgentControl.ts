/**
 * Agent-to-agent control writes (agentWakeService.ts).
 *
 * Every query is keyed by Agent.id, so cost scales with the one agent being acted on.
 */

import { type AgentStatus } from '@prisma/client';
import { prisma } from '../../providers/database';

/** Undo a wake CAS whose workflow start failed (only while nothing else claimed the row). */
export async function restoreTerminalAgentAfterFailedWake(
  agentId: string,
  status: AgentStatus,
  workflowId: string | null
) {
  return prisma.agent.updateMany({
    where: { id: agentId, status: 'ACTIVE', temporalWorkflowId: null },
    data: { status, temporalWorkflowId: workflowId },
  });
}
