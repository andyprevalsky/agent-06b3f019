import type { InterruptedWorkflowToolsResult, ToolProgressCandidate } from './staleWorkflowTools';
import { WorkflowNotFoundError } from '@temporalio/client';
import { getTemporalClient, type TemporalWorkflowExecutionRef } from './temporal';
import { createLogger } from './logger';

const log = createLogger('WorkflowReplacement');

export interface WorkflowTerminationClient {
  getHandle: (
    workflowId: string,
    runId?: string,
    options?: { firstExecutionRunId?: string }
  ) => { terminate: (reason: string) => Promise<unknown> };
}

export async function terminateWorkflowChain(
  workflowClient: WorkflowTerminationClient,
  execution: TemporalWorkflowExecutionRef
): Promise<void> {
  await workflowClient
    .getHandle(execution.workflowId, undefined, {
      firstExecutionRunId: execution.firstExecutionRunId,
    })
    .terminate('Restarting with new worker code');
}

export async function terminateStaleTemporalWorkflow(
  execution: TemporalWorkflowExecutionRef,
  agentId: string
): Promise<void> {
  const client = await getTemporalClient();
  try {
    await terminateWorkflowChain(client.workflow, execution);
    log.info('Terminated stale workflow for replacement', {
      agent_id: agentId,
      workflow_id: execution.workflowId,
      first_execution_run_id: execution.firstExecutionRunId,
    });
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      log.info('Stale workflow already closed before replacement', {
        agent_id: agentId,
        workflow_id: execution.workflowId,
        first_execution_run_id: execution.firstExecutionRunId,
      });
      return;
    }
    throw error;
  }
}

export interface ReplaceStaleWorkflowDependencies {
  terminate: (execution: TemporalWorkflowExecutionRef) => Promise<void>;
  captureInProgressTools: (
    agentId: string,
    workflowGeneration: string
  ) => Promise<ToolProgressCandidate[]>;
  finalizeInterruptedTools: (
    agentId: string,
    workflowGeneration: string,
    preTerminationSnapshot: ToolProgressCandidate[]
  ) => Promise<InterruptedWorkflowToolsResult>;
  startFresh: () => Promise<TemporalWorkflowExecutionRef>;
}

/** Strictly order shutdown, durable tool reconciliation, and fresh execution. */
export async function replaceStaleWorkflow(
  params: {
    agentId: string;
    staleExecution: TemporalWorkflowExecutionRef | null;
    staleWorkflowGeneration: string | null;
  },
  dependencies: ReplaceStaleWorkflowDependencies
): Promise<TemporalWorkflowExecutionRef> {
  if (params.staleWorkflowGeneration !== null) {
    const preTerminationSnapshot = await dependencies.captureInProgressTools(
      params.agentId,
      params.staleWorkflowGeneration
    );
    if (params.staleExecution !== null) {
      await dependencies.terminate(params.staleExecution);
    }
    await dependencies.finalizeInterruptedTools(
      params.agentId,
      params.staleWorkflowGeneration,
      preTerminationSnapshot
    );
  }
  return dependencies.startFresh();
}
