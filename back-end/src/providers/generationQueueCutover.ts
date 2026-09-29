/**
 * Generation-queue straggler handling after cooperative cutover's drain SLO.
 *
 * Cooperative continue_as_new runs at turn-top and every in-tool park that is
 * not waiting on a running activity (approval, gate, signup, send_message,
 * wait_for, wait_seconds, spawn child/slot/pause, browser auth). Activity-bound
 * waits (browser / claude-code / explore handles) cannot continue_as_new until
 * the activity completes, so they may still be on the superseded queue when the
 * 45-minute SLO fires. Killing those agents as "dead stragglers" is wrong —
 * replace them onto the live generation.
 */
import { WorkflowNotFoundError } from '@temporalio/client';
import { prisma } from './database';
import { createLogger } from './logger';
import { getTemporalClient } from './temporal';

async function defaultRestartAgent(agentId: string): Promise<unknown> {
  const { restartAgent } = await import('../domains/agents/agentRestartService');
  return restartAgent(agentId);
}

const log = createLogger('GenerationQueueCutover');

export const GENERATION_CUTOVER_STATUS_PREFIX = 'Generation cutover:';

export type CutoverClearOutcome = 'cleared' | 'skipped' | 'failed';

export interface CutoverAgentRef {
  id: string;
  status: string;
  statusMessage: string | null;
  temporalWorkflowId: string | null;
}

export interface ClearSupersededGenerationWorkflowDependencies {
  findAgentByWorkflowId?: (workflowId: string) => Promise<CutoverAgentRef | null>;
  restartAgent?: (agentId: string) => Promise<unknown>;
  terminateOrphan?: (workflowId: string, reason: string) => Promise<CutoverClearOutcome>;
}

export function isGenerationCutoverFailure(statusMessage: string | null | undefined): boolean {
  return (
    typeof statusMessage === 'string' && statusMessage.startsWith(GENERATION_CUTOVER_STATUS_PREFIX)
  );
}

export function isDeploymentSealedWorkflowId(workflowId: string | null | undefined): boolean {
  return typeof workflowId === 'string' && workflowId.includes(':deployment-sealed:');
}

export function agentNeedsCutoverRecovery(agent: {
  status: string;
  statusMessage?: string | null;
  temporalWorkflowId?: string | null;
}): boolean {
  if (agent.status === 'FAILED' && isGenerationCutoverFailure(agent.statusMessage)) return true;
  return isDeploymentSealedWorkflowId(agent.temporalWorkflowId);
}

function isRestartFailure(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    typeof (result as { error: unknown }).error === 'string'
  );
}

async function defaultFindAgentByWorkflowId(workflowId: string): Promise<CutoverAgentRef | null> {
  return prisma.agent.findFirst({
    where: { deletedAt: null, temporalWorkflowId: workflowId },
    select: { id: true, status: true, statusMessage: true, temporalWorkflowId: true },
  });
}

async function defaultTerminateOrphan(
  workflowId: string,
  reason: string
): Promise<CutoverClearOutcome> {
  const client = await getTemporalClient();
  try {
    await client.workflow.getHandle(workflowId).terminate(reason);
    return 'cleared';
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) return 'skipped';
    throw error;
  }
}

/**
 * Move one workflow still on a superseded generation queue onto the live
 * generation. Owned agents are replaced (same path as POST /restart). Orphan
 * Temporal executions with no Agent row are terminated.
 */
export async function clearSupersededGenerationWorkflow(
  queue: string,
  workflowId: string,
  dependencies: ClearSupersededGenerationWorkflowDependencies = {}
): Promise<CutoverClearOutcome> {
  const findAgent = dependencies.findAgentByWorkflowId ?? defaultFindAgentByWorkflowId;
  const replace = dependencies.restartAgent ?? defaultRestartAgent;
  const terminateOrphan = dependencies.terminateOrphan ?? defaultTerminateOrphan;
  const agent = await findAgent(workflowId);

  try {
    if (agent !== null && agent.temporalWorkflowId === workflowId) {
      const result = await replace(agent.id);
      if (isRestartFailure(result)) {
        log.error('Generation cutover replacement failed', {
          agent_id: agent.id,
          workflow_id: workflowId,
          queue,
          error: (result as { error: string }).error,
        });
        return 'failed';
      }
      log.info('Replaced superseded-generation workflow', {
        agent_id: agent.id,
        workflow_id: workflowId,
        queue,
      });
      return 'cleared';
    }

    const outcome = await terminateOrphan(
      workflowId,
      `Generation cutover: orphan workflow on superseded queue ${queue}`
    );
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Generation cutover clear failed', {
      workflow_id: workflowId,
      queue,
      error: message,
    });
    return 'failed';
  }
}

type RestartFn = (agentId: string) => Promise<unknown>;

let restartOverride: RestartFn | null = null;

export function setCutoverRestartForTests(replace: RestartFn | null): void {
  restartOverride = replace;
}

export function formatReplyToAgentAction(params: {
  recoveredCutover: boolean;
  reject: boolean;
  attentionRequestId?: string;
  attentionResolved: boolean;
}): string {
  if (params.recoveredCutover) {
    return params.reject
      ? 'Rejected after deploy interruption and restarted'
      : 'Approved after deploy interruption and restarted';
  }
  if (!params.attentionRequestId) return 'Replied to';
  if (params.attentionResolved) {
    return params.reject ? 'Rejected request and replied to' : 'Approved request and replied to';
  }
  return 'Replied to (request was already resolved or not found for)';
}

export async function recoverCutoverKilledAgent(
  agentId: string,
  replace: RestartFn = restartOverride ?? defaultRestartAgent
): Promise<boolean> {
  const result = await replace(agentId);
  if (isRestartFailure(result)) {
    log.error('Failed to recover cutover-killed agent', {
      agent_id: agentId,
      error: (result as { error: string }).error,
    });
    return false;
  }
  return true;
}
