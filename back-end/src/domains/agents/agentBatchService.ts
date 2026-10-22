import { resolveBatchProjectIds } from './agentProject';
import { resolveCreateTaskPaths } from './agentTaskPathCreate';
import { isWorkflowStartAdmissionPending } from '../../providers/workflowQueueAdmission';
/**
 * Agent batch-create service — POST /api/agents/batch.
 *
 * Used by the spawn_sub_agents_batch worker activity to fan out N sub-agents
 * in one HTTP call instead of N. Phase 1 is an atomic Prisma transaction; if
 * any row fails the whole batch rolls back. Phase 2 starts each Temporal
 * workflow in parallel via Promise.allSettled and relies on the SDK's built-in
 * gRPC retry interceptor (see @temporalio/client/lib/grpc-retry — retries on
 * UNKNOWN, RESOURCE_EXHAUSTED, UNAVAILABLE, ABORTED, DATA_LOSS, OUT_OF_RANGE,
 * and INTERNAL with specific RST_STREAM messages, up to 10 attempts with
 * exponential backoff). Rows whose workflow start ultimately fails are marked
 * FAILED so the row reflects reality. Re-POSTing with the same agent_ids is
 * idempotent: existing rows are returned unchanged with already_existed=true.
 */

import { startAgentWorkflowExecution } from '../../providers/temporal';
import { bindStartedRunIdentity } from '../../providers/workflowGeneration';
import { createLogger } from '../../providers/logger';
import { DEFAULT_TASK_PRICE_LIMIT_CENTS } from '../../providers/priceLimitDefaults';
import { resolvePromptSecrets } from './agentLifecycleService';
import {
  executeDescendantWorkflowStart,
  readDescendantWorkflowStartState,
  type DescendantWorkflowStartIdentity,
} from '../../providers/descendantWorkflowStart';
import { assertExistingDescendantRequestMatches } from './agentDescendantStartService';
import {
  applyFastModeDefault,
  applyMemoryDefault,
  assertWorldModelModeAccess,
  disableFastModeForWorldModel,
} from './agentExecutionMode';
import {
  applyExecutionModeInheritanceForBatch,
  inheritsBenchmarkFromBatchParent,
  loadBatchParentExecutionFlags,
} from './agentBatchParentFlags';
import { resolveCreateMetadata } from './agentCreateMetadata';
import type { CreateAgentBody } from './types';
import * as repo from './repo';
import type { BatchCreateAgentParams } from './repo';

const log = createLogger('AgentsBatch');

export interface BatchAgentResult {
  agent_id: string;
  status: 'STARTING_UP' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'FAILED';
  temporal_workflow_id: string | null;
  goal?: string;
  model?: string;
  error?: string;
  already_existed?: boolean;
}

interface BatchCreateAgentsArgs {
  bodies: CreateAgentBody[];
  userId: string;
  isInternal: boolean;
  clientIP: string | null;
}

type ResolvedMetadata = Awaited<ReturnType<typeof resolveCreateMetadata>>;

/** Build the BatchCreateAgentParams row used by createAgentBatchTransaction. */
function buildBatchItem(
  body: CreateAgentBody,
  userId: string,
  meta: ResolvedMetadata,
  verifierType: string,
  isBenchmark = false
): BatchCreateAgentParams {
  const agentId = body.agent_id!;
  return {
    agentId,
    userId,
    parentAgentId: body.parent_agent_id ?? null,
    parentWorkflowId: body.parent_workflow_id ?? null,
    depth: body.depth ?? 0,
    busId: body.parent_agent_id !== undefined ? (body.bus_id ?? null) : agentId,
    goal: body.goal,
    model: body.model,
    reasoningMaxTokens: body.reasoning_max_tokens,
    source: body.source,
    tokenInPriceMicrodollars: meta.tokenInPriceMicrodollars,
    tokenOutPriceMicrodollars: meta.tokenOutPriceMicrodollars,
    pauseState: body.pause_state,
    responseSchema: body.response_schema as unknown,
    proxyCountry: meta.proxyGeo.country,
    ...(meta.proxyGeo.state !== undefined ? { proxyState: meta.proxyGeo.state } : {}),
    ...(meta.proxyGeo.city !== undefined ? { proxyCity: meta.proxyGeo.city } : {}),
    ...(body.price_limit_cents !== undefined ? { priceLimitCents: body.price_limit_cents } : {}),
    ...(body.write_lock_enabled !== undefined ? { writeLockEnabled: body.write_lock_enabled } : {}),
    ...(body.fast_mode_cache_enabled !== undefined
      ? { fastModeCacheEnabled: body.fast_mode_cache_enabled }
      : {}),
    ...(body.world_model_mode !== undefined ? { worldModelMode: body.world_model_mode } : {}),
    ...(body.memory_enabled !== undefined ? { memoryEnabled: body.memory_enabled } : {}),
    ...(typeof body.project_id === 'string' ? { projectId: body.project_id } : {}),
    verifierType,
    ...(isBenchmark ? { isBenchmark: true } : {}),
    ...(body.attachments !== undefined
      ? { attachments: body.attachments as Array<Record<string, unknown>> }
      : {}),
    // Workflow id === agent id by convention (providers/temporal.ts:88).
    temporalWorkflowId: agentId,
    ...(body.max_iterations !== undefined ? { workflowMaxIterations: body.max_iterations } : {}),
    ...(body.context_gates !== undefined ? { workflowContextGates: body.context_gates } : {}),
    ...(body.start_phase !== undefined ? { workflowStartPhase: body.start_phase } : {}),
    ...(body.task_queue !== undefined ? { workflowTaskQueue: body.task_queue } : {}),
  };
}

/* c8 ignore start -- requires live Temporal Cloud */
async function startBatchWorkflow(
  body: CreateAgentBody,
  userId: string,
  verifierType: string,
  deadlineAtMs?: number
) {
  return startAgentWorkflowExecution(
    {
      agentId: body.agent_id!,
      userId,
      goal: body.goal,
      model: body.model,
      reasoningMaxTokens: body.reasoning_max_tokens,
      verifier: { type: verifierType },
      ...(body.task_queue !== undefined ? { taskQueue: body.task_queue } : {}),
      ...(body.parent_workflow_id !== undefined
        ? { parentWorkflowId: body.parent_workflow_id }
        : {}),
      ...(body.parent_agent_id !== undefined ? { parentAgentId: body.parent_agent_id } : {}),
      ...(body.depth !== undefined ? { depth: body.depth } : {}),
      ...(body.bus_id !== undefined ? { busId: body.bus_id } : {}),
      ...(body.start_phase !== undefined ? { startPhase: body.start_phase } : {}),
      ...(body.max_iterations !== undefined ? { maxIterations: body.max_iterations } : {}),
      priceLimitCents: body.price_limit_cents!,
      ...(body.context_gates !== undefined ? { contextGates: body.context_gates } : {}),
      ...(body.fast_mode_cache_enabled !== undefined
        ? { fastModeCacheEnabled: body.fast_mode_cache_enabled }
        : {}),
      ...(body.world_model_mode !== undefined ? { worldModelMode: body.world_model_mode } : {}),
      ...(body.memory_enabled !== undefined ? { memoryEnabled: body.memory_enabled } : {}),
      rejectDuplicateWorkflowId: true,
    },
    deadlineAtMs
  );
}
/* c8 ignore stop */

function descendantStartIdentity(body: CreateAgentBody): DescendantWorkflowStartIdentity | null {
  if (body.parent_agent_id === undefined || body.parent_workflow_id === undefined) return null;
  return {
    agentId: body.agent_id!,
    parentAgentId: body.parent_agent_id,
    parentWorkflowId: body.parent_workflow_id,
  };
}

async function startManagedBatchWorkflow(
  body: CreateAgentBody,
  userId: string,
  verifierType: string
): Promise<string> {
  const identity = descendantStartIdentity(body);
  if (identity === null) {
    const execution = await startBatchWorkflow(body, userId, verifierType);
    // The batch row was created with Workflow ID = agent ID; bind the run so
    // cleanup can tell this generation from a later follow-up run.
    await bindStartedRunIdentity(body.agent_id!, execution);
    return execution.workflowId;
  }
  const execution = await executeDescendantWorkflowStart(identity, (deadlineAtMs) =>
    startBatchWorkflow(body, userId, verifierType, deadlineAtMs)
  );
  if (execution === null) {
    throw new Error('Descendant workflow start settled without an execution');
  }
  return execution.workflowId;
}

/** Run phase 2 — Promise.allSettled of workflow starts. Marks failed rows
 *  FAILED in the DB and returns the per-child result map. */
async function runPhaseTwoStarts(
  newBodies: CreateAgentBody[],
  userId: string,
  verifierType: string
): Promise<Map<string, BatchAgentResult>> {
  const startResults = await Promise.allSettled(
    newBodies.map((body) => startManagedBatchWorkflow(body, userId, verifierType))
  );
  const out = new Map<string, BatchAgentResult>();
  for (let i = 0; i < newBodies.length; i++) {
    const body = newBodies[i];
    const settled = startResults[i];
    const agentId = body.agent_id!;
    if (settled.status === 'fulfilled') {
      out.set(agentId, {
        agent_id: agentId,
        status: 'STARTING_UP',
        temporal_workflow_id: settled.value,
        goal: body.goal,
        model: body.model,
      });
      continue;
    }
    const pendingAdmission = isWorkflowStartAdmissionPending(settled.reason);
    const errMsg =
      settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
    log.error('Batch workflow start failed', { agent_id: agentId, error: errMsg });
    const state = await readDescendantWorkflowStartState(agentId);
    if (!pendingAdmission && state?.temporalWorkflowStartPending !== true) {
      await repo
        .failAgentIfStillActive(agentId, 'Failed to start workflow: ' + errMsg)
        .catch((e: unknown) =>
          log.error('Failed to mark agent FAILED after workflow-start error', {
            agent_id: agentId,
            error: e instanceof Error ? e.message : String(e),
          })
        );
    }
    out.set(agentId, {
      agent_id: agentId,
      status: pendingAdmission ? 'STARTING_UP' : 'FAILED',
      temporal_workflow_id: null,
      goal: body.goal,
      model: body.model,
      error: errMsg,
    });
  }
  return out;
}

/** Resolve metadata for each input body, caching by (model, parent_agent_id).
 *  Sub-agents sharing a parent — the common spawn_sub_agent_for_each case —
 *  collapse to a single parent-proxy lookup and one model-pricing lookup. */
async function resolveAllMetadata(
  bodies: CreateAgentBody[],
  clientIP: string | null,
  userId: string
): Promise<Map<CreateAgentBody, ResolvedMetadata>> {
  const cache = new Map<string, ResolvedMetadata>();
  const out = new Map<CreateAgentBody, ResolvedMetadata>();
  for (const body of bodies) {
    const key = `${body.model} ${body.parent_agent_id ?? ''}`;
    let cached = cache.get(key);
    if (!cached) {
      cached = await resolveCreateMetadata(
        body.model,
        clientIP,
        body.parent_agent_id ?? null,
        userId
      );
      cache.set(key, cached);
    }
    out.set(body, cached);
  }
  return out;
}

export async function createAgentsBatch(args: BatchCreateAgentsArgs): Promise<BatchAgentResult[]> {
  const { bodies, userId, isInternal, clientIP } = args;
  const verifierType = 'FLOAT_LLM_JUDGE';
  const memoryOmittedOnRequest = new Set(
    bodies.filter((body) => body.memory_enabled === undefined).map((body) => body.agent_id!)
  );

  if (isInternal) {
    for (const body of bodies) body.goal = resolvePromptSecrets(body.goal);
  }
  for (const body of bodies) applyFastModeDefault(body, userId);
  const parentById = await loadBatchParentExecutionFlags(bodies, userId);
  applyExecutionModeInheritanceForBatch(bodies, parentById);
  await resolveBatchProjectIds(bodies, userId, parentById);
  for (const body of bodies) {
    applyMemoryDefault(body, inheritsBenchmarkFromBatchParent(body, parentById));
    disableFastModeForWorldModel(body);
    assertWorldModelModeAccess(body, userId);
  }

  for (const body of bodies) body.price_limit_cents ??= DEFAULT_TASK_PRICE_LIMIT_CENTS;

  // Idempotency: existing rows are returned untouched.
  const allAgentIds = bodies.map((b) => b.agent_id!);
  const existing = await repo.findExistingAgentsByIds(allAgentIds, userId);
  const existingById = new Map(existing.map((a) => [a.id, a]));
  for (const body of bodies) {
    const stored = existingById.get(body.agent_id!);
    if (stored !== undefined) {
      // Parent inheritance/defaulting above is for new rows. An idempotent
      // retry that omitted this immutable field must recover the durable child
      // value before collision validation, even when the parent's value later
      // changed or differs from the child.
      if (memoryOmittedOnRequest.has(body.agent_id!)) {
        body.memory_enabled = stored.memoryEnabled;
      }
      assertExistingDescendantRequestMatches(body, stored);
    }
  }

  const newBodies = bodies.filter((b) => !existingById.has(b.agent_id!));
  const pendingBodies = bodies.filter(
    (body) => existingById.get(body.agent_id!)?.temporalWorkflowStartPending === true
  );
  const metaMap = await resolveAllMetadata(newBodies, clientIP, userId);
  const newItems = newBodies.map((b) =>
    buildBatchItem(
      b,
      userId,
      metaMap.get(b)!,
      verifierType,
      inheritsBenchmarkFromBatchParent(b, parentById)
    )
  );

  const taskPaths = await resolveCreateTaskPaths(newBodies);
  newItems.forEach((item, index) => {
    item.taskPath = taskPaths[index];
  });
  if (newItems.length > 0) {
    // Phase 1: atomic create. Rolls back on any error.
    await repo.createAgentBatchTransaction(newItems);
  }

  // Phase 2: parallel workflow starts (with built-in gRPC retry).
  const newResultByAgentId = await runPhaseTwoStarts(
    [...newBodies, ...pendingBodies],
    userId,
    verifierType
  );

  // Mirror input order; existing rows surface their stored status.
  return bodies.map((body) => {
    const agentId = body.agent_id!;
    const newResult = newResultByAgentId.get(agentId);
    if (newResult) return newResult;
    const row = existingById.get(agentId)!;
    return {
      agent_id: row.id,
      status: row.status as BatchAgentResult['status'],
      temporal_workflow_id: row.temporalWorkflowId,
      goal: row.goal,
      model: row.model,
      already_existed: true,
    };
  });
}
