/**
 * Shared agent resume primitive for domain services that need to unblock a workflow.
 */

import { prisma } from './database';
import { getTemporalClient } from './temporal';
import { createLogger } from './logger';
import { getUserUsage } from './credits';
import {
  recordWorkflowResumeIntent,
  rollbackWorkflowResumeIntent,
  type WorkflowResumeIntentResult,
} from './workflowReplacementState';

const log = createLogger('AgentResume');

export type ResumeAgentWorkflowResult = { success: true } | { error: string; status: number };

interface ResumeAgentWorkflowDependencies {
  signalResume?: (workflowId: string) => Promise<void>;
  hasCredits?: (userId: string) => Promise<boolean>;
}

type ReadyResumeIntent = Extract<WorkflowResumeIntentResult, { outcome: 'ready' }>;

async function signalResume(workflowId: string): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.getHandle(workflowId).signal('resume');
}

async function deliverResumeSignal(
  agentId: string,
  intent: ReadyResumeIntent,
  signal: (workflowId: string) => Promise<void>
): Promise<ResumeAgentWorkflowResult> {
  if (intent.replacementOwned && intent.persistedActiveIntent) return { success: true };
  if (intent.workflowId === null) return { success: true };
  try {
    await signal(intent.workflowId);
  } catch (error) {
    if (intent.persistedActiveIntent) {
      const rolledBack = await rollbackWorkflowResumeIntent(agentId, intent.workflowId);
      if (!rolledBack) return { success: true };
    }
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

export async function resumeAgentWorkflow(
  agentId: string,
  dependencies: ResumeAgentWorkflowDependencies = {}
): Promise<ResumeAgentWorkflowResult> {
  let intent = await recordWorkflowResumeIntent(agentId);
  if (intent.outcome === 'not_found') return { error: 'Agent not found', status: 404 };
  if (intent.outcome === 'terminal') {
    return { error: 'Cannot resume a completed workflow', status: 409 };
  }
  if (intent.requiresCreditCheck) {
    const hasCredits =
      dependencies.hasCredits ??
      (async (userId: string) => {
        const usage = await getUserUsage(userId);
        return usage.remaining > 0;
      });
    if (!(await hasCredits(intent.userId))) {
      return { error: 'Cannot resume agent because the user has no credits', status: 409 };
    }
    intent = await recordWorkflowResumeIntent(agentId, { creditsRestored: true });
    if (intent.outcome === 'not_found') return { error: 'Agent not found', status: 404 };
    if (intent.outcome === 'terminal') {
      return { error: 'Cannot resume a completed workflow', status: 409 };
    }
  }
  return deliverResumeSignal(agentId, intent, dependencies.signalResume ?? signalResume);
}

/**
 * Unlocked pre-check so the common ACTIVE case never takes the generation lock.
 * A replacement-owned row can hide a pause in its saved prior status, so the
 * locked intent makes the final call. A child under a paused or cost-limited
 * parent is refused exactly like the /resume route, because its workflow would
 * reject the signal and leave the row claiming a resume that never happened.
 */
async function mayHoldLiftablePause(agentId: string): Promise<boolean> {
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: {
      status: true,
      workflowReplacementToken: true,
      parent: { select: { status: true, deletedAt: true } },
    },
  });
  if (agent === null) return false;
  if (agent.status !== 'PAUSED' && agent.workflowReplacementToken === null) return false;
  const parent = agent.parent;
  if (parent === null || parent.deletedAt !== null) return true;
  return parent.status !== 'PAUSED' && parent.status !== 'COST_LIMIT_REACHED';
}

/**
 * A user's message to an agent they paused is their instruction to continue.
 * Call only after what they sent is durable, so the woken workflow reads it on
 * its next turn. Cost limits and credit stops are untouched; they keep their
 * own unblock paths. Never throws: the send already succeeded, so a failed
 * resume must not fail it. Returns whether a pause was lifted.
 */
export async function resumePausedAgentForUserMessage(
  agentId: string,
  dependencies: Pick<ResumeAgentWorkflowDependencies, 'signalResume'> = {}
): Promise<boolean> {
  try {
    if (!(await mayHoldLiftablePause(agentId))) return false;
    const intent = await recordWorkflowResumeIntent(agentId);
    if (intent.outcome !== 'ready' || !intent.persistedActiveIntent) return false;
    const result = await deliverResumeSignal(
      agentId,
      intent,
      dependencies.signalResume ?? signalResume
    );
    if ('error' in result) return false;
    log.info('Resumed paused agent for user message', { agent_id: agentId });
    return true;
  } catch (error) {
    log.warn('Resume after user message failed; agent stays paused', {
      agent_id: agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

interface UserMessageDeliveryDependencies extends Pick<
  ResumeAgentWorkflowDependencies,
  'signalResume'
> {
  signalUserResponse?: (workflowId: string, signalValue: string) => Promise<void>;
}

async function sendUserResponseSignal(workflowId: string, signalValue: string): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.getHandle(workflowId).signal('receive_user_response', signalValue);
}

/** Best-effort `receive_user_response` signal. Returns whether it was delivered. */
export async function signalUserResponse(
  agentId: string,
  workflowId: string,
  signalValue: string,
  dependencies: Pick<UserMessageDeliveryDependencies, 'signalUserResponse'> = {}
): Promise<boolean> {
  try {
    await (dependencies.signalUserResponse ?? sendUserResponseSignal)(workflowId, signalValue);
    return true;
  } catch (error) {
    log.error('Failed to signal workflow', {
      agent_id: agentId,
      workflow_id: workflowId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Deliver what the user sent (a message, reply, or approval decision) to the
 * agent's workflow and lift a pause they set: sending is the instruction to
 * continue, so no channel has to follow a send with its own /resume. The pause
 * is lifted even if the signal is lost, because the resumed loop polls the
 * database for new rows before every LLM turn.
 */
export async function deliverUserMessageToWorkflow(
  agentId: string,
  workflowId: string,
  signalValue: string,
  dependencies: UserMessageDeliveryDependencies = {}
): Promise<{ signaled: boolean; resumed: boolean }> {
  const signaled = await signalUserResponse(agentId, workflowId, signalValue, dependencies);
  const resumed = await resumePausedAgentForUserMessage(agentId, dependencies);
  return { signaled, resumed };
}

/**
 * Best-effort `receive_agent_message` signal for an agent-to-agent message row.
 * Deliberately distinct from `receive_user_response`: an agent message is not
 * user feedback (no response-schema update) and never lifts a user pause. The
 * payload names the durable row (plus its sender, for wait_for matching); the
 * workflow reads it from the DB and must dedupe by `message_id` (idempotent
 * retries re-signal the same row).
 */
export interface AgentMessageSignalPayload {
  message_id: string;
  /** Sender identity lets the target's wait_for(agents=[...]) match it. */
  from_agent_id?: string;
  from_agent_path?: string;
  wake_task_id?: string;
  message?: string;
  /** Resuming a paused browser/code task: continue its conversation or start fresh. */
  continue_conversation?: boolean;
}

export async function signalAgentMessage(
  agentId: string,
  workflowId: string,
  messageId: string,
  sender: {
    from_agent_id?: string;
    from_agent_path?: string | null;
    /** A finished own background task to start the next run of, with the message text. */
    wake_task_id?: string;
    message?: string;
    continue_conversation?: boolean;
  } = {},
  send: (workflowId: string, payload: AgentMessageSignalPayload) => Promise<void> = async (
    id,
    payload
  ) => {
    const client = await getTemporalClient();
    await client.workflow.getHandle(id).signal('receive_agent_message', payload);
  }
): Promise<boolean> {
  try {
    const payload: AgentMessageSignalPayload = { message_id: messageId };
    if (sender.from_agent_id) payload.from_agent_id = sender.from_agent_id;
    if (sender.from_agent_path) payload.from_agent_path = sender.from_agent_path;
    if (sender.wake_task_id !== undefined && sender.message !== undefined) {
      payload.wake_task_id = sender.wake_task_id;
      payload.message = sender.message;
      if (sender.continue_conversation !== undefined)
        payload.continue_conversation = sender.continue_conversation;
    }
    await send(workflowId, payload);
    return true;
  } catch (error) {
    log.warn('Failed to signal agent message', {
      agent_id: agentId,
      workflow_id: workflowId,
      message_id: messageId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
