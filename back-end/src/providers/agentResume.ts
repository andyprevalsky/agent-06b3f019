/**
 * Shared agent resume primitive for domain services that need to unblock a workflow.
 */

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
 * A user's message to an agent they paused is their instruction to continue.
 * Call only after the USER row is durable and `receive_user_response` has been
 * signaled, so the woken workflow reads the message on its next turn. Cost
 * limits and credit stops are untouched; they keep their own unblock paths.
 * Never throws: the message is already delivered, so a failed resume must not
 * fail the send. Returns whether a pause was lifted.
 */
export async function resumePausedAgentForUserMessage(
  agentId: string,
  dependencies: Pick<ResumeAgentWorkflowDependencies, 'signalResume'> = {}
): Promise<boolean> {
  try {
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
