/**
 * Best-effort control signal for the agent-to-agent kill_agent tool. Like
 * `signalAgentMessage` in agentResume.ts it never lifts a user pause and never
 * counts as user feedback; the target workflow dedupes by idempotency key. A
 * failed signal is reported, never thrown.
 */

import { getTemporalClient } from './temporal';
import { createLogger } from './logger';

const log = createLogger('AgentControlSignals');

export type AgentControlSignalName = 'kill';

export type SignalSender = (
  workflowId: string,
  name: AgentControlSignalName,
  payload: Record<string, unknown>
) => Promise<void>;

const temporalSend: SignalSender = async (workflowId, name, payload) => {
  const client = await getTemporalClient();
  await client.workflow.getHandle(workflowId).signal(name, payload);
};

/** Signal `name` with `payload` to one agent workflow. Returns whether it was delivered. */
export async function signalAgentControl(
  agentId: string,
  workflowId: string,
  name: AgentControlSignalName,
  payload: Record<string, unknown>,
  send: SignalSender = temporalSend
): Promise<boolean> {
  try {
    await send(workflowId, name, payload);
    return true;
  } catch (error) {
    log.warn(`Failed to signal ${name}`, {
      agent_id: agentId,
      workflow_id: workflowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
