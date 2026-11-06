import { broadcastAgentUpdate } from '../../providers/chat';
import { createLogger } from '../../providers/logger';

const log = createLogger('Agents');

/** Tell clients that a completed agent is active again before its chat turn streams. */
export async function broadcastChatReactivation(agentId: string, busId?: string): Promise<void> {
  await broadcastAgentUpdate(
    agentId,
    {
      status: 'ACTIVE',
      temporalWorkflowId: null,
      progress: 0,
      updatedAt: new Date().toISOString(),
    },
    busId
  ).catch((error: unknown) =>
    log.warn('Failed to broadcast chat reactivation', {
      agent_id: agentId,
      error: error instanceof Error ? error.message : String(error),
    })
  );
}
