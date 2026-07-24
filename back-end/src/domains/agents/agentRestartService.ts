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
  claimWorkflowReplacement,
  finalizeWorkflowReplacementBootstrap as finalizeReplacementBootstrap,
  markWorkflowReplacementFailed,
  refreshWorkflowReplacementResumeState,
  recordStaleWorkflowChain,
  recordWorkflowReplacementStartAcceptance,
  type WorkflowReplacementClaim,
} from '../../providers/workflowReplacementState';
import { workflowReplacementDeploymentAttempt } from '../../providers/workflowReplacementResumeState';
import { cleanupTerminalAgentWorkflowZombies } from '../../providers/workflowTerminalCleanup';
import type { UpdateStatusBody } from './types';
import * as repo from './repo';

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
    },
    deadlineAtMs
  );
}

interface StartedWorkflowAcceptanceDependencies {
  recordAcceptance: typeof recordWorkflowReplacementStartAcceptance;
  terminate: typeof terminateStaleTemporalWorkflow;
  cleanup: (agentId: string, deadlineAtMs?: number) => Promise<unknown>;
}

const startedWorkflowAcceptanceDependencies: StartedWorkflowAcceptanceDependencies = {
  recordAcceptance: recordWorkflowReplacementStartAcceptance,
  terminate: terminateStaleTemporalWorkflow,
  cleanup: (agentId, deadlineAtMs) =>
    cleanupTerminalAgentWorkflowZombies(
      {},
      {
        agentIds: [agentId],
        ignoreGrace: true,
        maxConcurrency: 1,
        batchSize: 1,
        deadlineAtMs,
      }
    ),
};

/** Compensate an accepted Temporal start if a newer DB generation won first. */
export async function acceptStartedWorkflowReplacement(
  claim: WorkflowReplacementClaim,
  execution: TemporalWorkflowExecutionRef,
  deadlineAtMs?: number,
  dependencyOverrides: Partial<StartedWorkflowAcceptanceDependencies> = {}
): Promise<void> {
  const dependencies = { ...startedWorkflowAcceptanceDependencies, ...dependencyOverrides };
  if (await dependencies.recordAcceptance(claim, execution)) return;

  let directTerminationError: unknown;
  try {
    await dependencies.terminate(execution, claim.agentId, deadlineAtMs);
  } catch (error) {
    directTerminationError = error;
  }
  try {
    // The rejected acceptance durably recorded this exact execution. Consume
    // that obligation now; if cleanup fails, the cron retains it for retry.
    await dependencies.cleanup(claim.agentId, deadlineAtMs);
  } catch (cleanupError) {
    throw new AggregateError(
      directTerminationError === undefined
        ? [cleanupError]
        : [directTerminationError, cleanupError],
      `Stale workflow replacement ${execution.workflowId} could not be fully cleaned up`
    );
  }
  throw new Error(
    `Workflow replacement ${execution.workflowId} became stale before start acceptance and was terminated`
  );
}

/** Keep a pre-lock tool snapshot only when the claim sealed that same generation. */
export async function captureClaimedStaleWorkflowTools(
  agentId: string,
  claimedStaleWorkflowId: string | null,
  capturedStaleWorkflowId: string | null,
  preClaimSnapshot: Awaited<ReturnType<typeof captureInProgressWorkflowTools>>,
  capture: typeof captureInProgressWorkflowTools = captureInProgressWorkflowTools
): Promise<Awaited<ReturnType<typeof captureInProgressWorkflowTools>>> {
  if (claimedStaleWorkflowId === capturedStaleWorkflowId) return preClaimSnapshot;
  if (claimedStaleWorkflowId === null) return [];
  return capture(agentId, claimedStaleWorkflowId);
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
  const expectedWorkflowId =
    options.expectedWorkflowId ?? capturedStaleWorkflowId ?? agent.temporalWorkflowId;
  const claim =
    expectedWorkflowId === null
      ? await claimWorkflowReplacement(agentId, launchConfig)
      : await claimWorkflowReplacement(agentId, launchConfig, {
          expectedWorkflowId,
          ...(options.deploymentAttempt === undefined
            ? {}
            : { deploymentAttempt: options.deploymentAttempt }),
        });
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
    await markWorkflowReplacementFailed(claim, error);
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
