/**
 * Agent control service — pause, resume, restart, update status, update config, signals.
 */

import type { Prisma } from '@prisma/client';
import { getTemporalClient, startAgentWorkflow } from '../../providers/temporal';
import { broadcastAgentUpdate, broadcastAgentModeStarted } from '../../providers/chat';
import { createLogger } from '../../providers/logger';
import type { UpdateStatusBody } from './types';
import * as repo from './repo';

export { updateAgentConfig } from './agentConfigService';

const log = createLogger('Agents');

// ---------------------------------------------------------------------------
// Pause / Resume
// ---------------------------------------------------------------------------

/** Pause a single agent. Children discover parent's paused state via pull-based queries. */
export async function pauseAgent(agentId: string): Promise<void> {
  const agent = await repo.findAgentById(agentId);

  if (!agent) {
    return;
  }

  if (agent.status === 'COMPLETED' || agent.status === 'FAILED') {
    log.info('Skipping pause - already terminal', { agent_id: agentId, status: agent.status });
    return;
  }

  await repo.updateAgent(agentId, { status: 'PAUSED' });

  if (agent.temporalWorkflowId !== null) {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.signal('pause');
    } catch (error) {
      log.warn('Pause signal failed, DB updated. Workflow will sync next iteration', {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Resume a single agent. Children discover parent's resumed state via pull-based queries. */
export async function resumeAgent(agentId: string): Promise<void> {
  const agent = await repo.findAgentById(agentId);

  if (!agent) {
    return;
  }

  await repo.updateAgent(agentId, { status: 'ACTIVE' });

  if (agent.temporalWorkflowId !== null) {
    try {
      const client = await getTemporalClient();
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.signal('resume');
    } catch (error) {
      log.warn('Resume signal failed, DB updated. Workflow will sync next iteration', {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Pause an agent for a user (verifies ownership first). */
export async function pauseAgentForUser(agentId: string, userId: string) {
  const agent = await repo.findAgent(agentId, userId);

  if (!agent) {
    return { error: 'Agent not found', status: 404 };
  }

  await pauseAgent(agentId);
  return { success: true };
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

  await resumeAgent(agentId);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Escalate to agent mode
// ---------------------------------------------------------------------------

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

  const workflowId = await startAgentWorkflow({
    agentId,
    userId: agent.userId,
    goal: agent.goal,
    model: agent.model,
    reasoningMaxTokens: agent.reasoningMaxTokens,
    verifier: {
      type: agent.verifier.type,
      llmJudgePrompt: agent.verifier.llmJudgePrompt,
    },
    priceLimitCents: agent.priceLimitCents,
  });

  await repo.updateAgent(agentId, { temporalWorkflowId: workflowId });
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
// Restart
// ---------------------------------------------------------------------------

/** Restart an agent's workflow. */
export async function restartAgent(agentId: string, userId?: string) {
  const agent = await repo.findAgentWithVerifier(agentId, userId);

  if (!agent) {
    return { error: 'Agent not found', status: 404 };
  }

  if (agent.verifier === null) {
    return { error: 'Agent has no verifier configured', status: 400 };
  }

  if (agent.temporalWorkflowId !== null) {
    const client = await getTemporalClient();
    try {
      const handle = client.workflow.getHandle(agent.temporalWorkflowId);
      await handle.terminate('Restarting with new worker code');
      log.info('Terminated workflow for restart', {
        agent_id: agentId,
        workflow_id: agent.temporalWorkflowId,
      });
    } catch (e: unknown) {
      const isNotFound = e instanceof Error && e.name === 'WorkflowNotFoundError';
      if (isNotFound) {
        log.info('Workflow already terminated/not found, proceeding with restart', {
          agent_id: agentId,
          workflow_id: agent.temporalWorkflowId,
        });
      } else {
        log.error('Failed to terminate workflow for restart, aborting to prevent duplicates', {
          agent_id: agentId,
          workflow_id: agent.temporalWorkflowId,
          error: e instanceof Error ? e.message : String(e),
        });
        return { error: 'Failed to terminate existing workflow', status: 500 };
      }
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 500));

  await repo.updateAgent(agentId, { status: 'ACTIVE', statusMessage: null });

  const workflowId = await startAgentWorkflow({
    agentId: agent.id,
    userId: agent.userId,
    goal: agent.goal,
    model: agent.model,
    reasoningMaxTokens: agent.reasoningMaxTokens,
    verifier: {
      type: agent.verifier.type,
      llmJudgePrompt: agent.verifier.llmJudgePrompt,
    },
    ...(agent.parentWorkflowId !== null ? { parentWorkflowId: agent.parentWorkflowId } : {}),
    depth: agent.depth,
    priceLimitCents: agent.priceLimitCents,
  });

  await repo.updateAgent(agentId, { temporalWorkflowId: workflowId });

  log.info('Restarted agent', { agent_id: agentId, workflow_id: workflowId });

  return {
    success: true,
    agent_id: agentId,
    workflow_id: workflowId,
    message: 'Workflow restarted - will continue from existing context',
  };
}

// ---------------------------------------------------------------------------
// Update status (internal/worker)
// ---------------------------------------------------------------------------

/** Agent fields relevant for status broadcast. */
interface AgentStatusFields {
  progress: number;
  status: string;
  statusMessage: string | null;
  tokenCount: number;
  tokensIn: number;
  tokensOut: number;
  contextSize: number;
  messageCount: number;
}

export async function updateAgentStatus(agentId: string, body: UpdateStatusBody) {
  const agent = await repo.findAgentById(agentId);

  if (!agent) {
    return null;
  }

  const updated = await repo.updateAgent(agentId, {
    status: body.status,
    statusMessage: body.statusMessage,
    progress: body.progress,
    tokenCount: body.tokenCount,
    tokensIn: body.tokensIn,
    tokensOut: body.tokensOut,
    contextSize: body.contextSize,
    messageCount: body.messageCount,
    ...(body.structuredResponse !== undefined && {
      structuredResponse: body.structuredResponse as Prisma.InputJsonValue,
    }),
    updatedAt: new Date(),
  });

  const fields = updated as unknown as AgentStatusFields;
  await broadcastAgentUpdate(agentId, {
    progress: fields.progress,
    status: fields.status,
    statusMessage: fields.statusMessage ?? undefined,
    tokenCount: fields.tokenCount,
    tokensIn: fields.tokensIn,
    tokensOut: fields.tokensOut,
    contextSize: fields.contextSize,
    messageCount: fields.messageCount,
  });

  return updated;
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
