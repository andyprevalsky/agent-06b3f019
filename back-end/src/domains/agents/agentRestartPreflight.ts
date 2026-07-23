import { WorkflowNotFoundError } from '@temporalio/client';
import { readAgentWorkflowLaunchConfig } from '../../providers/temporal';
import { captureInProgressWorkflowTools } from '../../providers/staleWorkflowTools';
import * as repo from './repo';

interface AgentRestartPreflightDependencies {
  findAgentWithVerifier: typeof repo.findAgentWithVerifier;
  captureInProgressTools: typeof captureInProgressWorkflowTools;
  readLaunchConfig: typeof readAgentWorkflowLaunchConfig;
}

const defaultDependencies: AgentRestartPreflightDependencies = {
  findAgentWithVerifier: repo.findAgentWithVerifier,
  captureInProgressTools: captureInProgressWorkflowTools,
  readLaunchConfig: readAgentWorkflowLaunchConfig,
};

export interface AgentWorkflowReplacementPreflightOptions {
  expectedWorkflowId?: string;
  deadlineAtMs?: number;
}

export type AgentWorkflowReplacementPreflight =
  { outcome: 'ready' } | { outcome: 'skipped' } | { outcome: 'failed'; error: string };

function assertDeadline(deadlineAtMs: number | undefined, phase: string): void {
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    throw new Error(`Workflow migration deadline exceeded during ${phase}`);
  }
}

/**
 * Validate every deterministic, candidate-specific replacement prerequisite
 * without claiming, terminating, appending messages, or changing agent state.
 */
export async function preflightAgentWorkflowReplacement(
  agentId: string,
  userId?: string,
  options: AgentWorkflowReplacementPreflightOptions = {},
  dependencyOverrides: Partial<AgentRestartPreflightDependencies> = {}
): Promise<AgentWorkflowReplacementPreflight> {
  try {
    const dependencies = { ...defaultDependencies, ...dependencyOverrides };
    assertDeadline(options.deadlineAtMs, 'candidate preflight');
    const agent = await dependencies.findAgentWithVerifier(agentId, userId);
    if (agent === null || agent.status === 'COMPLETED' || agent.status === 'FAILED') {
      return { outcome: 'skipped' };
    }
    const expectedWorkflowId = options.expectedWorkflowId;
    if (
      expectedWorkflowId !== undefined &&
      agent.temporalWorkflowId !== expectedWorkflowId &&
      !(
        agent.workflowReplacementToken !== null &&
        agent.staleTemporalWorkflowId === expectedWorkflowId
      )
    ) {
      return { outcome: 'skipped' };
    }
    if (agent.verifier === null) {
      return { outcome: 'failed', error: 'Agent has no verifier configured' };
    }

    const staleWorkflowId =
      agent.workflowReplacementToken === null
        ? agent.temporalWorkflowId
        : agent.staleTemporalWorkflowId;
    if (staleWorkflowId !== null) {
      await dependencies.captureInProgressTools(agentId, staleWorkflowId);
    }
    assertDeadline(options.deadlineAtMs, 'tool preflight');
    if (agent.workflowReplacementToken === null && agent.temporalWorkflowId !== null) {
      try {
        await dependencies.readLaunchConfig(agent.temporalWorkflowId, options.deadlineAtMs);
      } catch (error) {
        if (!(error instanceof WorkflowNotFoundError)) throw error;
      }
    } else if (
      agent.workflowReplacementToken !== null &&
      (agent.temporalWorkflowId === null ||
        agent.workflowReplacementState === null ||
        typeof agent.workflowReplacementState !== 'object' ||
        Array.isArray(agent.workflowReplacementState) ||
        agent.workflowReplacementState.version !== 1 ||
        agent.workflowReplacementState.kind !== 'deployment')
    ) {
      throw new Error(`Agent ${agentId} has an incomplete workflow replacement claim`);
    }
    assertDeadline(options.deadlineAtMs, 'launch config preflight');
    return { outcome: 'ready' };
  } catch (error) {
    return {
      outcome: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
