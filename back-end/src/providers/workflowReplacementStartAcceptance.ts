import type { TemporalWorkflowExecutionRef } from './temporal';
import { terminateStaleTemporalWorkflow } from './workflowReplacement';
import {
  recordWorkflowReplacementStartAcceptance,
  type WorkflowReplacementClaim,
} from './workflowReplacementState';
import { cleanupTerminalAgentWorkflowZombies } from './workflowTerminalCleanup';

export interface StartedWorkflowAcceptanceDependencies {
  recordAcceptance: typeof recordWorkflowReplacementStartAcceptance;
  terminate: typeof terminateStaleTemporalWorkflow;
  cleanup: (agentId: string, deadlineAtMs?: number) => Promise<unknown>;
}

const defaultDependencies: StartedWorkflowAcceptanceDependencies = {
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
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
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
