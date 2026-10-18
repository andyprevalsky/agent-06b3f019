import { isWorkflowStartAdmissionPending } from '../../providers/workflowQueueAdmission';
/**
 * Generation-fenced agent workflow replacement orchestration.
 */

import { WorkflowNotFoundError } from '@temporalio/client';
import {
  readAgentWorkflowLaunchConfig,
  resolveTemporalWorkflowExecutionRef,
  startAgentWorkflowExecution,
  type TemporalWorkflowExecutionRef,
} from '../../providers/temporal';
import { createLogger } from '../../providers/logger';
import { releaseTerminatedWorkflowResources } from '../../providers/agentCleanup';
import {
  captureInProgressWorkflowTools,
  finalizeInterruptedWorkflowTools,
} from '../../providers/staleWorkflowTools';
import { cleanupNonterminalDescendantWorkflows } from '../../providers/workflowDescendantCleanup';
import {
  sealStaleWorkflow,
  terminateStaleTemporalWorkflow,
} from '../../providers/workflowReplacement';
import {
  acknowledgeWorkflowReplacementBootstrap as acknowledgeReplacementBootstrap,
  finalizeWorkflowReplacementBootstrap as finalizeReplacementBootstrap,
  markWorkflowReplacementFailed,
  refreshWorkflowReplacementResumeState,
  recordStaleWorkflowChain,
  type WorkflowReplacementClaim,
} from '../../providers/workflowReplacementState';
import { workflowReplacementDeploymentAttempt } from '../../providers/workflowReplacementResumeState';
import { acceptStartedWorkflowReplacement } from '../../providers/workflowReplacementStartAcceptance';
import {
  captureClaimedStaleWorkflowTools,
  claimReplacementGeneration,
} from '../../providers/workflowReplacementPreparation';
import type { UpdateStatusBody } from './types';
import { normalizeWorldModelMode } from './agentExecutionMode';
import * as repo from './repo';

export { acceptStartedWorkflowReplacement, captureClaimedStaleWorkflowTools };

const log = createLogger('Agents');

export interface RestartAgentOptions {
  expectedWorkflowId?: string;
  deploymentAttempt?: string;
  deadlineAtMs?: number;
}

export interface PreparedAgentWorkflowReplacement {
  prepared: true;
  agentId: string;
  userId: string | undefined;
  claim: WorkflowReplacementClaim;
  deadlineAtMs: number | undefined;
}

type RestartableAgent = NonNullable<Awaited<ReturnType<typeof repo.findAgentWithVerifier>>>;

function assertRestartDeadline(deadlineAtMs: number | undefined, phase: string): void {
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    throw new Error(`Workflow migration deadline exceeded during ${phase}`);
  }
}

async function historicalLaunchConfig(agent: RestartableAgent, deadlineAtMs?: number) {
  if (agent.workflowReplacementToken !== null || agent.temporalWorkflowId === null) {
    return undefined;
  }
  try {
    return await readAgentWorkflowLaunchConfig(agent.temporalWorkflowId, deadlineAtMs);
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return undefined;
    throw error;
  }
}

async function staleExecutionForReplacement(
  claim: WorkflowReplacementClaim,
  deadlineAtMs?: number
): Promise<TemporalWorkflowExecutionRef | null> {
  if (claim.staleWorkflowId === null) return null;
  if (claim.staleFirstExecutionRunId !== null) {
    return {
      workflowId: claim.staleWorkflowId,
      firstExecutionRunId: claim.staleFirstExecutionRunId,
    };
  }
  try {
    const execution = await resolveTemporalWorkflowExecutionRef(
      claim.staleWorkflowId,
      deadlineAtMs
    );
    await recordStaleWorkflowChain(claim, execution);
    return execution;
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return null;
    await markWorkflowReplacementFailed(claim, error);
    throw error;
  }
}

async function startReplacementWorkflow(
  agent: RestartableAgent,
  verifierType: string,
  claim: WorkflowReplacementClaim,
  deadlineAtMs?: number
): Promise<TemporalWorkflowExecutionRef> {
  const currentParent =
    agent.parentAgentId !== null ? await repo.findAgentById(agent.parentAgentId) : null;
  const parentWorkflowId = currentParent?.temporalWorkflowId ?? agent.parentWorkflowId;
  return startAgentWorkflowExecution(
    {
      agentId: agent.id,
      userId: agent.userId,
      goal: agent.goal,
      model: agent.model,
      reasoningMaxTokens: agent.reasoningMaxTokens,
      verifier: { type: verifierType },
      workflowId: claim.plannedWorkflowId,
      rejectDuplicateWorkflowId: true,
      ...(parentWorkflowId !== null ? { parentWorkflowId } : {}),
      ...(agent.parentAgentId !== null ? { parentAgentId: agent.parentAgentId } : {}),
      ...(agent.busId !== null ? { busId: agent.busId } : {}),
      depth: agent.depth,
      priceLimitCents: agent.priceLimitCents,
      fastModeCacheEnabled: agent.fastModeCacheEnabled,
      memoryEnabled: agent.memoryEnabled,
      worldModelMode: normalizeWorldModelMode(agent.worldModelMode),
      startPhase: 'resume',
      ...(claim.resumeState.max_iterations !== null
        ? { maxIterations: claim.resumeState.max_iterations }
        : {}),
      ...(claim.resumeState.context_gates !== null
        ? { contextGates: claim.resumeState.context_gates }
        : {}),
      resumeState: claim.resumeState,
    },
    deadlineAtMs
  );
}

async function sealClaimedReplacement(
  agentId: string,
  claim: WorkflowReplacementClaim,
  staleExecution: TemporalWorkflowExecutionRef | null,
  preTerminationSnapshot: Awaited<ReturnType<typeof captureInProgressWorkflowTools>>,
  deadlineAtMs?: number
): Promise<WorkflowReplacementClaim> {
  let finalClaim = claim;
  try {
    await sealStaleWorkflow(
      {
        agentId,
        staleExecution,
        staleWorkflowGeneration: claim.staleWorkflowId,
        preTerminationSnapshot,
      },
      {
        captureInProgressTools: captureInProgressWorkflowTools,
        terminate: (stale) => terminateStaleTemporalWorkflow(stale, agentId, deadlineAtMs),
        finalizeInterruptedTools: finalizeInterruptedWorkflowTools,
      }
    );
    assertRestartDeadline(deadlineAtMs, 'descendant cleanup');
    await cleanupNonterminalDescendantWorkflows(agentId, {}, { deadlineAtMs });
    assertRestartDeadline(deadlineAtMs, 'browser release');
    // Close the sealed generation's rented browsers and code sandboxes.
    //
    // Browser/explore/code sub-agents are ACTIVITIES of the root workflow, not
    // descendants — they own no Agent row, so descendant cleanup cannot see
    // them. Temporal `terminate()` closes the workflow without cancelling its
    // in-flight activities, the browser activity has no cancellation poll, and
    // its own `close_browser_session` sits in a `try` rather than a `finally`.
    // Replacement also keeps the agent non-terminal, so the terminal-status
    // release hook never fires either. Without this call the rented browser is
    // simply orphaned and keeps billing (prod: 90 minutes on one agent), and an
    // old Claude Code CLI keeps working next to the replacement run.
    await releaseTerminatedWorkflowResources(agentId, 'Cutover');
    assertRestartDeadline(deadlineAtMs, 'replacement state refresh');
    finalClaim = await refreshWorkflowReplacementResumeState(claim);
    return finalClaim;
  } catch (error) {
    await markWorkflowReplacementFailed(finalClaim, error);
    throw error;
  }
}

/* c8 ignore start -- live Temporal orchestration */
/** Seal one stale workflow generation without exposing it to candidate code. */
export async function prepareAgentWorkflowReplacement(
  agentId: string,
  userId?: string,
  options: RestartAgentOptions = {}
) {
  assertRestartDeadline(options.deadlineAtMs, 'candidate read');
  const agent = await repo.findAgentWithVerifier(agentId, userId);
  if (agent === null) {
    if (options.expectedWorkflowId !== undefined) {
      return {
        success: true,
        skipped: true,
        agent_id: agentId,
        workflow_id: null,
        expected_workflow_id: options.expectedWorkflowId,
        message: 'Workflow disappeared after the deployment snapshot; no replacement was started',
      };
    }
    return { error: 'Agent not found', status: 404 };
  }
  if (agent.verifier === null) return { error: 'Agent has no verifier configured', status: 400 };

  const rotatesPriorDeployment =
    agent.workflowReplacementToken !== null &&
    options.deploymentAttempt !== undefined &&
    workflowReplacementDeploymentAttempt(agent.workflowReplacementState) !==
      options.deploymentAttempt;
  const capturedStaleWorkflowId =
    agent.workflowReplacementToken === null || rotatesPriorDeployment
      ? agent.temporalWorkflowId
      : agent.staleTemporalWorkflowId;
  const preTerminationSnapshot =
    capturedStaleWorkflowId === null
      ? []
      : await captureInProgressWorkflowTools(agentId, capturedStaleWorkflowId);
  assertRestartDeadline(options.deadlineAtMs, 'tool snapshot');
  const launchConfig = await historicalLaunchConfig(agent, options.deadlineAtMs);
  assertRestartDeadline(options.deadlineAtMs, 'launch config read');
  const claim = await claimReplacementGeneration(
    agentId,
    launchConfig,
    options.expectedWorkflowId === undefined && options.deploymentAttempt === undefined
      ? null
      : (options.expectedWorkflowId ?? capturedStaleWorkflowId ?? agent.temporalWorkflowId),
    options.deploymentAttempt
  );
  assertRestartDeadline(options.deadlineAtMs, 'replacement claim');
  if ('skipped' in claim) {
    return {
      success: true,
      skipped: true,
      agent_id: agentId,
      workflow_id: claim.currentWorkflowId,
      expected_workflow_id: claim.expectedWorkflowId,
      message: 'Workflow advanced after the deployment snapshot; no replacement was started',
    };
  }

  const claimedPreTerminationSnapshot = await captureClaimedStaleWorkflowTools(
    agentId,
    claim.staleWorkflowId,
    capturedStaleWorkflowId,
    preTerminationSnapshot
  );
  assertRestartDeadline(options.deadlineAtMs, 'claimed tool snapshot');
  const staleExecution = await staleExecutionForReplacement(claim, options.deadlineAtMs);
  const finalClaim = await sealClaimedReplacement(
    agentId,
    claim,
    staleExecution,
    claimedPreTerminationSnapshot,
    options.deadlineAtMs
  );
  return {
    prepared: true,
    agentId,
    userId,
    claim: finalClaim,
    deadlineAtMs: options.deadlineAtMs,
  } satisfies PreparedAgentWorkflowReplacement;
}

/** Start an already-sealed replacement after the candidate build is activated. */
export async function startPreparedAgentWorkflowReplacement(
  prepared: PreparedAgentWorkflowReplacement
) {
  const { agentId, userId, claim, deadlineAtMs } = prepared;
  try {
    assertRestartDeadline(deadlineAtMs, 'candidate start');
    const freshAgent = await repo.findAgentWithVerifier(agentId, userId);
    if (freshAgent === null || freshAgent.verifier === null) {
      throw new Error(`Agent ${agentId} disappeared before replacement start`);
    }
    const execution = await startReplacementWorkflow(
      freshAgent,
      freshAgent.verifier.type,
      claim,
      deadlineAtMs
    );
    assertRestartDeadline(deadlineAtMs, 'candidate start acceptance');
    await acceptStartedWorkflowReplacement(claim, execution, deadlineAtMs);
    log.info('Restarted agent', { agent_id: agentId, workflow_id: execution.workflowId });
    return {
      success: true,
      agent_id: agentId,
      workflow_id: execution.workflowId,
      message: 'Workflow restarted - will continue from existing context',
    };
  } catch (error) {
    if (!isWorkflowStartAdmissionPending(error)) await markWorkflowReplacementFailed(claim, error);
    throw error;
  }
}

/** Restart an agent's workflow from its durable database state. */
export async function restartAgent(
  agentId: string,
  userId?: string,
  options: RestartAgentOptions = {}
) {
  const prepared = await prepareAgentWorkflowReplacement(agentId, userId, options);
  if (prepared.prepared !== true) return prepared;
  return startPreparedAgentWorkflowReplacement(prepared);
}

/** Consume a durable replacement snapshot after the candidate restored it. */
export async function acknowledgeWorkflowReplacementBootstrap(
  agentId: string,
  workflowGeneration: string
) {
  return acknowledgeReplacementBootstrap(agentId, workflowGeneration);
}

/** Atomically persist restored counters, preserve newer control state, and READY-ack. */
export async function finalizeWorkflowReplacementBootstrap(
  agentId: string,
  workflowGeneration: string,
  restoredState: UpdateStatusBody | undefined
) {
  return finalizeReplacementBootstrap(agentId, workflowGeneration, restoredState);
}
/* c8 ignore stop */
