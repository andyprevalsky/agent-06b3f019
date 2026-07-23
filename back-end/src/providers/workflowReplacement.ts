import type { InterruptedWorkflowToolsResult, ToolProgressCandidate } from './staleWorkflowTools';
import { type Client, WorkflowNotFoundError } from '@temporalio/client';
import {
  getTemporalClient,
  type TemporalWorkflowExecutionRef,
  withTemporalControlDeadline,
} from './temporal';
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

export async function terminateWorkflowChainWithDeadline(
  client: Pick<Client, 'withDeadline'> & { workflow: WorkflowTerminationClient },
  execution: TemporalWorkflowExecutionRef,
  deadlineAtMs?: number
): Promise<void> {
  await withTemporalControlDeadline(
    client,
    () => terminateWorkflowChain(client.workflow, execution),
    deadlineAtMs
  );
}

export async function terminateStaleTemporalWorkflow(
  execution: TemporalWorkflowExecutionRef,
  agentId: string,
  deadlineAtMs?: number
): Promise<void> {
  const client = await getTemporalClient();
  try {
    await terminateWorkflowChainWithDeadline(client, execution, deadlineAtMs);
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

export type SealStaleWorkflowDependencies = Omit<ReplaceStaleWorkflowDependencies, 'startFresh'>;

/** Strictly order shutdown and durable tool reconciliation without starting new code. */
export async function sealStaleWorkflow(
  params: {
    agentId: string;
    staleExecution: TemporalWorkflowExecutionRef | null;
    staleWorkflowGeneration: string | null;
    preTerminationSnapshot?: ToolProgressCandidate[];
  },
  dependencies: SealStaleWorkflowDependencies
): Promise<void> {
  if (params.staleWorkflowGeneration !== null) {
    const preTerminationSnapshot =
      params.preTerminationSnapshot ??
      (await dependencies.captureInProgressTools(params.agentId, params.staleWorkflowGeneration));
    if (params.staleExecution !== null) {
      await dependencies.terminate(params.staleExecution);
    }
    await dependencies.finalizeInterruptedTools(
      params.agentId,
      params.staleWorkflowGeneration,
      preTerminationSnapshot
    );
  }
}

/** Strictly order shutdown, durable tool reconciliation, and fresh execution. */
export async function replaceStaleWorkflow(
  params: {
    agentId: string;
    staleExecution: TemporalWorkflowExecutionRef | null;
    staleWorkflowGeneration: string | null;
    preTerminationSnapshot?: ToolProgressCandidate[];
  },
  dependencies: ReplaceStaleWorkflowDependencies
): Promise<TemporalWorkflowExecutionRef> {
  await sealStaleWorkflow(params, dependencies);
  return dependencies.startFresh();
}
