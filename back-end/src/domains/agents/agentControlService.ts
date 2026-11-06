/**
 * Agent control service — pause, resume, restart, update status, update config, signals.
 */

import type { AgentStatus } from '@prisma/client';

import {
  getTemporalClient,
  startAgentWorkflowExecution,
  type StartAgentWorkflowParams,
} from '../../providers/temporal';
import { broadcastAgentModeStarted, broadcastAgentUpdate } from '../../providers/chat';
import { createLogger } from '../../providers/logger';
import { resumeAgentWorkflow } from '../../providers/agentResume';
import * as repo from './repo';
import { normalizeWorldModelMode } from './agentExecutionMode';

export { updateAgentConfig } from './agentConfigService';
export { updateAgentStatus } from './agentStatusService';
export {
  acknowledgeWorkflowReplacementBootstrap,
  finalizeWorkflowReplacementBootstrap,
  restartAgent,
  type RestartAgentOptions,
} from './agentRestartService';

const log = createLogger('Agents');

// ---------------------------------------------------------------------------
// Pause / Resume
// ---------------------------------------------------------------------------

/** Pause a single agent. Children discover parent's paused state via pull-based queries. */
export async function pauseAgent(agentId: string): Promise<number | undefined> {
  const paused = await repo.pauseAgentUnderWorkflowLock(agentId);
  if (paused === null) return;
  if (!paused.paused) {
    log.info('Skipping pause - already terminal', { agent_id: agentId, status: paused.status });
    return paused.userControlRevision;
  }

  /* c8 ignore start -- Temporal signal requires live Temporal server */
  if (paused.temporalWorkflowId !== null) {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(paused.temporalWorkflowId);
      // No cause argument: the cause-aware handler defaults to 'user', and a
      // draining older generation's `pause(self)` fails its task on any argument.
      await handle.signal('pause');
    } catch (error) {
      log.warn('Pause signal failed, DB updated. Workflow will sync next iteration', {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  /* c8 ignore stop */
  await broadcastUserControlState(agentId, paused);
  return paused.userControlRevision;
}

/** Broadcast committed ordering metadata; transport failure cannot revoke accepted control. */
async function broadcastUserControlState(
  agentId: string,
  agent: {
    status: AgentStatus;
    userControlRevision: number;
    updatedAt: Date;
  }
) {
  try {
    await broadcastAgentUpdate(agentId, {
      status: agent.status,
      userControlRevision: agent.userControlRevision,
      updatedAt: agent.updatedAt.toISOString(),
    });
  } catch (error) {
    log.warn('Control state broadcast failed; snapshot reconciliation remains available', {
      agent_id: agentId,
      error: String(error),
    });
  }
}

/** Resume a single agent. Children discover parent's resumed state via pull-based queries. */
export async function resumeAgent(agentId: string) {
  const result = await resumeAgentWorkflow(agentId);
  if ('success' in result) {
    const current = await repo.findAgentById(agentId);
    if (current) await broadcastUserControlState(agentId, current);
  }
  return result;
}

/** Pause an agent for a user (verifies ownership first). */
export async function pauseAgentForUser(agentId: string, userId: string) {
  const agent = await repo.findAgent(agentId, userId);

  if (!agent) {
    return { error: 'Agent not found', status: 404 };
  }

  const userControlRevision = await pauseAgent(agentId);
  return { success: true, user_control_revision: userControlRevision };
}

/** Resume an agent for a user (verifies ownership and parent state). */
export async function resumeAgentForUser(agentId: string, userId: string) {
  const agent = await repo.findAgent(agentId, userId);

  if (!agent) {
    return { error: 'Agent not found', status: 404 };
  }

  if (agent.parentAgentId !== null) {
    const parentStatus = await repo.findParentStatus(agent.parentAgentId);
    if (
      parentStatus !== null &&
      (parentStatus.status === 'PAUSED' || parentStatus.status === 'COST_LIMIT_REACHED')
    ) {
      return {
        error: `Cannot resume agent — parent agent is ${parentStatus.status === 'COST_LIMIT_REACHED' ? 'cost-limited' : 'paused'}. Resume the root agent first.`,
        status: 400,
      };
    }
  }

  return resumeAgent(agentId);
}

// ---------------------------------------------------------------------------
// Escalate to agent mode
// ---------------------------------------------------------------------------

/* c8 ignore start -- startAgentMode, restartAgent, signalWorkflow require live Temporal server */
/** Manually escalate from chat mode to agent mode. */
export async function startAgentMode(agentId: string, userId: string) {
  const agent = await repo.findAgentWithVerifier(agentId, userId);

  if (!agent) {
    return { error: 'Agent not found', status: 404 };
  }

  if (agent.temporalWorkflowId !== null) {
    return { error: 'Agent is already in agent mode', status: 400 };
  }

  if (agent.verifier === null) {
    return { error: 'Agent has no verifier configured', status: 400 };
  }

  log.info('Manual escalation to agent mode', {
    agent_id: agentId,
    goal: agent.goal.substring(0, 100),
  });

  const execution = await startAgentWorkflowExecution({
    agentId,
    userId: agent.userId,
    goal: agent.goal,
    model: agent.model,
    reasoningMaxTokens: agent.reasoningMaxTokens,
    verifier: {
      type: agent.verifier.type,
    },
    priceLimitCents: agent.priceLimitCents,
    fastModeCacheEnabled: agent.fastModeCacheEnabled,
    memoryEnabled: agent.memoryEnabled,
    worldModelMode: normalizeWorldModelMode(agent.worldModelMode),
    ...(agent.workflowMaxIterations !== null ? { maxIterations: agent.workflowMaxIterations } : {}),
    ...(agent.workflowContextGates !== null
      ? {
          contextGates: agent.workflowContextGates as StartAgentWorkflowParams['contextGates'],
        }
      : {}),
  });

  // Record the chain identity, not just the reusable workflow id: terminal
  // cleanup tells this chain from an earlier one under the same id by run id.
  const workflowId = execution.workflowId;
  await repo.updateAgent(agentId, {
    temporalWorkflowId: workflowId,
    temporalFirstExecutionRunId: execution.firstExecutionRunId,
  });
  await broadcastAgentModeStarted(agentId);

  log.info('Escalated to agent mode', {
    agent_id: agentId,
    workflow_id: workflowId,
  });

  return {
    success: true,
    agent_id: agentId,
    workflow_id: workflowId,
  };
}

// ---------------------------------------------------------------------------
// Workflow signals
// ---------------------------------------------------------------------------

/** Signal a workflow (signup_completed or signup_dismissed). */
export async function signalWorkflow(
  agentId: string,
  userId: string,
  signalName: 'signup_completed' | 'signup_dismissed'
) {
  const agent = await repo.findAgent(agentId, userId);

  if (!agent) {
    return { error: 'Agent not found', status: 404 };
  }

  if (agent.temporalWorkflowId !== null) {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(agent.temporalWorkflowId);
    await handle.signal(signalName);
    log.info(`Sent ${signalName} signal`, {
      workflow_id: agent.temporalWorkflowId,
      agent_id: agentId,
    });
  }

  return { success: true };
}
/* c8 ignore stop */
