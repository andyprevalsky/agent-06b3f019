/**
 * Agent control service — pause, resume, restart, update status, update config, signals.
 */

import { WorkflowNotFoundError } from '@temporalio/client';
import {
  getTemporalClient,
  readAgentWorkflowLaunchConfig,
  resolveTemporalWorkflowExecutionRef,
  startAgentWorkflow,
  startAgentWorkflowExecution,
  type StartAgentWorkflowParams,
  type TemporalWorkflowExecutionRef,
} from '../../providers/temporal';
import { broadcastAgentModeStarted } from '../../providers/chat';
import { createLogger } from '../../providers/logger';
import { resumeAgentWorkflow } from '../../providers/agentResume';
import {
  captureInProgressWorkflowTools,
  finalizeInterruptedWorkflowTools,
} from '../../providers/staleWorkflowTools';
import {
  replaceStaleWorkflow,
  terminateStaleTemporalWorkflow,
} from '../../providers/workflowReplacement';
import {
  claimWorkflowReplacement,
  completeWorkflowReplacement,
  markWorkflowReplacementFailed,
  recordStaleWorkflowChain,
  type WorkflowReplacementClaim,
} from '../../providers/workflowReplacementState';
import * as repo from './repo';

export { updateAgentConfig } from './agentConfigService';
export { updateAgentStatus } from './agentStatusService';

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

  /* c8 ignore start -- Temporal signal requires live Temporal server */
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
  /* c8 ignore stop */
}

/** Resume a single agent. Children discover parent's resumed state via pull-based queries. */
export async function resumeAgent(agentId: string) {
  return resumeAgentWorkflow(agentId);
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

  const workflowId = await startAgentWorkflow({
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
    ...(agent.workflowMaxIterations !== null ? { maxIterations: agent.workflowMaxIterations } : {}),
    ...(agent.workflowContextGates !== null
      ? {
          contextGates: agent.workflowContextGates as StartAgentWorkflowParams['contextGates'],
        }
      : {}),
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

async function startReplacementWorkflow(
  agent: NonNullable<Awaited<ReturnType<typeof repo.findAgentWithVerifier>>>,
  verifierType: string,
  claim: WorkflowReplacementClaim
): Promise<TemporalWorkflowExecutionRef> {
  const currentParent =
    agent.parentAgentId !== null ? await repo.findAgentById(agent.parentAgentId) : null;
  const parentWorkflowId = currentParent?.temporalWorkflowId ?? agent.parentWorkflowId;
  return startAgentWorkflowExecution({
    agentId: agent.id,
    userId: agent.userId,
    goal: agent.goal,
    model: agent.model,
    reasoningMaxTokens: agent.reasoningMaxTokens,
    verifier: { type: verifierType },
    workflowId: claim.plannedWorkflowId,
    ...(parentWorkflowId !== null ? { parentWorkflowId } : {}),
    ...(agent.parentAgentId !== null ? { parentAgentId: agent.parentAgentId } : {}),
    ...(agent.busId !== null ? { busId: agent.busId } : {}),
    depth: agent.depth,
    priceLimitCents: agent.priceLimitCents,
    fastModeCacheEnabled: agent.fastModeCacheEnabled,
    startPhase: 'resume',
    ...(claim.resumeState.max_iterations !== null
      ? { maxIterations: claim.resumeState.max_iterations }
      : {}),
    ...(claim.resumeState.context_gates !== null
      ? { contextGates: claim.resumeState.context_gates }
      : {}),
    resumeState: claim.resumeState,
  });
}

/** Restart an agent's workflow. */
export async function restartAgent(agentId: string, userId?: string) {
  const agent = await repo.findAgentWithVerifier(agentId, userId);

  if (!agent) {
    return { error: 'Agent not found', status: 404 };
  }

  if (agent.verifier === null) {
    return { error: 'Agent has no verifier configured', status: 400 };
  }
  const verifierType = agent.verifier.type;
  let historicalLaunchConfig: Awaited<ReturnType<typeof readAgentWorkflowLaunchConfig>> | undefined;
  if (agent.workflowReplacementToken === null && agent.temporalWorkflowId !== null) {
    try {
      historicalLaunchConfig = await readAgentWorkflowLaunchConfig(agent.temporalWorkflowId);
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
  }
  const claim = await claimWorkflowReplacement(agentId, historicalLaunchConfig);
  let staleExecution: TemporalWorkflowExecutionRef | null = null;
  if (claim.staleWorkflowId !== null) {
    if (claim.staleFirstExecutionRunId !== null) {
      staleExecution = {
        workflowId: claim.staleWorkflowId,
        firstExecutionRunId: claim.staleFirstExecutionRunId,
      };
    } else {
      try {
        staleExecution = await resolveTemporalWorkflowExecutionRef(claim.staleWorkflowId);
        await recordStaleWorkflowChain(claim, staleExecution);
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) {
          await markWorkflowReplacementFailed(claim, error);
          throw error;
        }
      }
    }
  }

  let execution: TemporalWorkflowExecutionRef;
  try {
    execution = await replaceStaleWorkflow(
      {
        agentId,
        staleExecution,
        staleWorkflowGeneration: claim.staleWorkflowId,
      },
      {
        captureInProgressTools: captureInProgressWorkflowTools,
        terminate: (stale) => terminateStaleTemporalWorkflow(stale, agentId),
        finalizeInterruptedTools: finalizeInterruptedWorkflowTools,
        startFresh: () => startReplacementWorkflow(agent, verifierType, claim),
      }
    );
    await completeWorkflowReplacement(claim, execution);
  } catch (error) {
    await markWorkflowReplacementFailed(claim, error);
    throw error;
  }

  log.info('Restarted agent', { agent_id: agentId, workflow_id: execution.workflowId });

  return {
    success: true,
    agent_id: agentId,
    workflow_id: execution.workflowId,
    message: 'Workflow restarted - will continue from existing context',
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
