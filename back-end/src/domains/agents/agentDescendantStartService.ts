import { isDeepStrictEqual } from 'node:util';
import { startAgentWorkflowExecution } from '../../providers/temporal';
import { getX402Endpoints } from '../../providers/x402Endpoints';
import {
  executeDescendantWorkflowStart,
  readDescendantWorkflowStartState,
} from '../../providers/descendantWorkflowStart';
import { StaleParentWorkflowGenerationError } from '../../providers/workflowGeneration';
import type { CreateAgentBody } from './types';
import * as repo from './repo';

type Verifier = { type: string };
type ExistingDescendant = Awaited<ReturnType<typeof repo.findExistingAgentsByIds>>[number];

/**
 * Stable agent IDs make retries idempotent only when the immutable launch
 * intent is also identical. Reject payload drift instead of starting Temporal
 * with values that disagree with the durable child row.
 */
export function assertExistingDescendantRequestMatches(
  body: CreateAgentBody,
  existing: ExistingDescendant
): void {
  const fields: Array<[string, unknown, unknown]> = [
    ['parent_agent_id', body.parent_agent_id ?? null, existing.parentAgentId],
    ['parent_workflow_id', body.parent_workflow_id ?? null, existing.parentWorkflowId],
    ['goal', body.goal, existing.goal],
    ['model', body.model, existing.model],
    ['reasoning_max_tokens', body.reasoning_max_tokens, existing.reasoningMaxTokens],
    ['source', body.source, existing.source],
    ['depth', body.depth, existing.depth],
    ['bus_id', body.bus_id ?? null, existing.busId],
    ['start_phase', body.start_phase ?? null, existing.workflowStartPhase],
    ['task_queue', body.task_queue ?? null, existing.workflowTaskQueue],
    ['max_iterations', body.max_iterations ?? null, existing.workflowMaxIterations],
    [
      'price_limit_cents',
      body.price_limit_cents ?? existing.priceLimitCents,
      existing.priceLimitCents,
    ],
    ['context_gates', body.context_gates ?? null, existing.workflowContextGates],
    ['response_schema', body.response_schema ?? null, existing.responseSchema],
    [
      'fast_mode_cache_enabled',
      body.fast_mode_cache_enabled ?? existing.fastModeCacheEnabled,
      existing.fastModeCacheEnabled,
    ],
    ['memory_enabled', body.memory_enabled ?? existing.memoryEnabled, existing.memoryEnabled],
    ['world_model_mode', body.world_model_mode ?? 'real', existing.worldModelMode],
  ];
  const mismatch = fields.find(
    ([, requestValue, storedValue]) => !isDeepStrictEqual(requestValue, storedValue)
  );
  if (mismatch !== undefined) {
    throw new StaleParentWorkflowGenerationError(
      `Descendant retry payload changed immutable field ${mismatch[0]}`
    );
  }
}

/** Start one durable descendant outbox row with its immutable Workflow ID. */
export async function startSubAgentWorkflow(
  body: CreateAgentBody,
  agentDbId: string,
  userId: string,
  verifier: Verifier,
  priceLimitCents: number
): Promise<string> {
  if (body.parent_agent_id === undefined || body.parent_workflow_id === undefined) {
    throw new StaleParentWorkflowGenerationError();
  }
  const params = {
    agentId: agentDbId,
    userId,
    goal: body.goal,
    model: body.model,
    reasoningMaxTokens: body.reasoning_max_tokens,
    verifier: { type: verifier.type },
    ...(body.task_queue !== undefined ? { taskQueue: body.task_queue } : {}),
    parentWorkflowId: body.parent_workflow_id,
    parentAgentId: body.parent_agent_id,
    ...(body.depth !== undefined ? { depth: body.depth } : {}),
    ...(body.bus_id !== undefined ? { busId: body.bus_id } : {}),
    ...(body.start_phase !== undefined ? { startPhase: body.start_phase } : {}),
    ...(body.max_iterations !== undefined ? { maxIterations: body.max_iterations } : {}),
    priceLimitCents,
    ...(body.context_gates !== undefined ? { contextGates: body.context_gates } : {}),
    ...(body.fast_mode_cache_enabled !== undefined
      ? { fastModeCacheEnabled: body.fast_mode_cache_enabled }
      : {}),
    ...(body.world_model_mode !== undefined ? { worldModelMode: body.world_model_mode } : {}),
    ...(body.memory_enabled !== undefined ? { memoryEnabled: body.memory_enabled } : {}),
    rejectDuplicateWorkflowId: true,
  };
  const execution = await executeDescendantWorkflowStart(
    {
      agentId: agentDbId,
      parentAgentId: body.parent_agent_id,
      parentWorkflowId: body.parent_workflow_id,
    },
    (deadlineAtMs) => startAgentWorkflowExecution(params, deadlineAtMs)
  );
  if (execution === null) {
    throw new Error('Descendant workflow start settled without an execution');
  }
  return execution.workflowId;
}

/** Resume an idempotent single-child retry without inserting a duplicate row. */
export async function resumeExistingSubAgent(
  body: CreateAgentBody,
  userId: string,
  verifier: Verifier
) {
  if (body.agent_id === undefined || body.parent_agent_id === undefined) return null;
  const existing = (await repo.findExistingAgentsByIds([body.agent_id], userId))[0];
  if (existing === undefined) return null;
  if (body.fast_mode_cache_enabled === undefined) {
    body.fast_mode_cache_enabled = existing.fastModeCacheEnabled;
  }
  if (body.memory_enabled === undefined) {
    body.memory_enabled = existing.memoryEnabled;
  }
  assertExistingDescendantRequestMatches(body, existing);
  const workflowId = existing.temporalWorkflowStartPending
    ? await startSubAgentWorkflow(body, existing.id, userId, verifier, existing.priceLimitCents)
    : existing.temporalWorkflowId;
  return {
    agent_id: existing.id,
    project_id: existing.projectId,
    folder_id: existing.folderId,
    progress: existing.progress,
    goal: existing.goal,
    model: existing.model,
    source: existing.source,
    reasoning_max_tokens: existing.reasoningMaxTokens,
    status: existing.status,
    status_message: existing.statusMessage,
    temporal_workflow_id: workflowId,
    fast_mode_cache_enabled: existing.fastModeCacheEnabled,
    world_model_mode: existing.worldModelMode,
    created_at: existing.createdAt,
    updated_at: existing.updatedAt,
    available_endpoints: getX402Endpoints(existing.id),
  };
}

/** Preserve ambiguous starts for deterministic retry/reconciliation. */
export async function shouldKeepDescendantStartPending(agentId: string): Promise<boolean> {
  return (await readDescendantWorkflowStartState(agentId))?.temporalWorkflowStartPending === true;
}
