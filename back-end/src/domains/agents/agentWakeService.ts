/**
 * Wake a finished agent with an agent-to-agent message as its next task.
 *
 *   send_message_to_agent ──▶ target COMPLETED|FAILED|… with a workflow
 *        │  (message row already stored on the target, agentMessage metadata)
 *        ▼
 *   CAS: terminal status + observed workflow id ──▶ ACTIVE, workflow cleared,
 *        derived run state reset, Agent.goal = the message      (same as a chat
 *        follow-up: clearWorkflowForTerminalAgent + followUpRunStateUpdate)
 *        ▼
 *   start AgentWorkflow `<agent>:wake:<message id>` (execute phase) with the
 *   agent's own tree launch config (parent workflow, depth, bus, gates)
 *        ▼
 *   record the run identity (acceptChatWorkflowExecution, ACTIVE only)
 *        │ start throws
 *        ▼
 *   restore the observed terminal row (status, workflow identity, goal,
 *   derived run state) while it is still unclaimed; the message stays stored
 *
 * The new run reads its whole conversation from the database, so the message
 * is its newest input. A sub-agent reports to its parent again through
 * child_completed, which the parent turns into a fresh completion notification.
 * The message is never user feedback and never lifts a user pause (paused
 * agents are not terminal, so they are never woken here).
 *
 * Idempotent: the workflow id is derived from the message id and the CAS only
 * fires while the agent is still terminal, so a retried send cannot start two
 * runs. 10k agents: one primary-key read, one CAS and one start per wake.
 */

import {
  startAgentWorkflowExecution,
  type StartAgentWorkflowParams,
} from '../../providers/temporal';
import { acceptChatWorkflowExecution } from '../../providers/workflowGeneration';
import { followUpRunStateUpdate } from '../../providers/derivedRunState';
import { createLogger } from '../../providers/logger';
import { normalizeWorldModelMode } from './agentExecutionMode';
import * as repo from './repo';
import { restoreTerminalAgentAfterFailedWake } from './repoAgentControl';

const log = createLogger('AgentWake');

export const WAKEABLE_TERMINAL_STATUSES: ReadonlyArray<string> = [
  'COMPLETED',
  'FAILED',
  'OUT_OF_CREDITS',
  'COST_LIMIT_REACHED',
];

export interface WakeResult {
  woke: boolean;
  workflow_id?: string;
  reason?: string;
}

type WakeAgent = NonNullable<Awaited<ReturnType<typeof repo.findAgentWithVerifier>>>;

async function launchParams(
  agent: WakeAgent,
  workflowId: string,
  goal: string
): Promise<StartAgentWorkflowParams> {
  const parent =
    agent.parentAgentId !== null ? await repo.findAgentById(agent.parentAgentId) : null;
  const parentWorkflowId = parent?.temporalWorkflowId ?? agent.parentWorkflowId;
  return {
    agentId: agent.id,
    userId: agent.userId,
    goal,
    model: agent.model,
    reasoningMaxTokens: agent.reasoningMaxTokens,
    verifier: { type: agent.verifier?.type ?? 'llm' },
    workflowId,
    rejectDuplicateWorkflowId: true,
    ...(parentWorkflowId !== null ? { parentWorkflowId } : {}),
    ...(agent.parentAgentId !== null ? { parentAgentId: agent.parentAgentId } : {}),
    ...(agent.busId !== null ? { busId: agent.busId } : {}),
    depth: agent.depth,
    startPhase: agent.workflowStartPhase === 'browser' ? 'browser' : 'execute',
    priceLimitCents: agent.priceLimitCents,
    fastModeCacheEnabled: agent.fastModeCacheEnabled,
    memoryEnabled: agent.memoryEnabled,
    worldModelMode: normalizeWorldModelMode(agent.worldModelMode),
    ...(agent.workflowMaxIterations !== null ? { maxIterations: agent.workflowMaxIterations } : {}),
    ...(agent.workflowContextGates !== null
      ? { contextGates: agent.workflowContextGates as StartAgentWorkflowParams['contextGates'] }
      : {}),
  };
}

/**
 * Put a reactivated agent back to its observed terminal state after a failed
 * start: status, workflow identity, goal and the derived run state the wake reset.
 */
async function rollBackWake(agent: WakeAgent): Promise<void> {
  await restoreTerminalAgentAfterFailedWake(agent.id, agent);
}

/**
 * Start the next run of a finished agent whose newest row is `messageText`.
 * Never throws: a failed wake leaves the stored message and reports why.
 */
export async function wakeFinishedAgent(
  agentId: string,
  messageId: string,
  messageText: string
): Promise<WakeResult> {
  const agent = await repo.findAgentWithVerifier(agentId);
  if (agent === null) return { woke: false, reason: 'agent not found' };
  if (!WAKEABLE_TERMINAL_STATUSES.includes(agent.status) || agent.temporalWorkflowId === null) {
    return { woke: false, reason: `agent is ${agent.status}` };
  }
  if (agent.verifier === null) return { woke: false, reason: 'agent has no verifier' };

  const { count } = await repo.clearWorkflowForTerminalAgent(
    agent.id,
    agent.status,
    agent.temporalWorkflowId,
    agent.temporalFirstExecutionRunId
  );
  if (count === 0) return { woke: false, reason: 'agent changed state concurrently' };

  const update = followUpRunStateUpdate(messageText, agent.goal);
  await repo.updateAgent(agent.id, update);
  const goal = typeof update.goal === 'string' ? update.goal : agent.goal;
  const workflowId = `${agent.id}:wake:${messageId}`;
  try {
    const execution = await startAgentWorkflowExecution(
      await launchParams(agent, workflowId, goal)
    );
    if (!(await acceptChatWorkflowExecution(agent.id, execution))) {
      log.warn('Wake start superseded before acceptance', { agent_id: agent.id, workflowId });
      return { woke: false, reason: 'superseded by a concurrent start' };
    }
    log.info('Woke finished agent for agent message', {
      agent_id: agent.id,
      workflow_id: execution.workflowId,
      message_id: messageId,
      previous_status: agent.status,
    });
    return { woke: true, workflow_id: execution.workflowId };
  } catch (error) {
    await rollBackWake(agent);
    const reason = error instanceof Error ? error.message : String(error);
    log.error('Failed to wake finished agent', {
      agent_id: agent.id,
      message_id: messageId,
      reason,
    });
    return { woke: false, reason: reason.slice(0, 200) };
  }
}
