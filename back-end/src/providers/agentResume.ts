/**
 * Shared agent resume primitive for domain services that need to unblock a workflow.
 */

import { getTemporalClient } from './temporal';
import { createLogger } from './logger';
import { getUserUsage } from './credits';
import {
  recordWorkflowResumeIntent,
  rollbackWorkflowResumeIntent,
} from './workflowReplacementState';

const log = createLogger('AgentResume');

export type ResumeAgentWorkflowResult = { success: true } | { error: string; status: number };

interface ResumeAgentWorkflowDependencies {
  signalResume?: (workflowId: string) => Promise<void>;
  hasCredits?: (userId: string) => Promise<boolean>;
}

async function signalResume(workflowId: string): Promise<void> {
  const client = await getTemporalClient();
  await client.workflow.getHandle(workflowId).signal('resume');
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
  if (intent.replacementOwned && intent.persistedActiveIntent) return { success: true };

  /* c8 ignore start -- Temporal signal requires live Temporal server */
  if (intent.workflowId !== null) {
    try {
      await (dependencies.signalResume ?? signalResume)(intent.workflowId);
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
  /* c8 ignore stop */

  return { success: true };
}
