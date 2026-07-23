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

import { startAgentWorkflow } from '../../providers/temporal';
import { createLogger } from '../../providers/logger';
import { resolvePromptSecrets } from './agentLifecycleService';
import {
  applyFastModeDefault,
  applyFastModeInheritance,
  applyWorldModelModeInheritance,
  disableFastModeForWorldModel,
} from './agentExecutionMode';
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
  verifierType: string
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
    verifierType,
    ...(body.attachments !== undefined
      ? { attachments: body.attachments as Array<Record<string, unknown>> }
      : {}),
    // Workflow id === agent id by convention (providers/temporal.ts:88).
    temporalWorkflowId: agentId,
  };
}

/* c8 ignore start -- requires live Temporal Cloud */
async function startBatchWorkflow(
  body: CreateAgentBody,
  userId: string,
  verifierType: string
): Promise<string> {
  return startAgentWorkflow({
    agentId: body.agent_id!,
    userId,
    goal: body.goal,
    model: body.model,
    reasoningMaxTokens: body.reasoning_max_tokens,
    verifier: { type: verifierType },
    ...(body.task_queue !== undefined ? { taskQueue: body.task_queue } : {}),
    ...(body.parent_workflow_id !== undefined ? { parentWorkflowId: body.parent_workflow_id } : {}),
    ...(body.parent_agent_id !== undefined ? { parentAgentId: body.parent_agent_id } : {}),
    ...(body.depth !== undefined ? { depth: body.depth } : {}),
    ...(body.bus_id !== undefined ? { busId: body.bus_id } : {}),
    ...(body.start_phase !== undefined ? { startPhase: body.start_phase } : {}),
    ...(body.max_iterations !== undefined ? { maxIterations: body.max_iterations } : {}),
    priceLimitCents: body.price_limit_cents ?? 100,
    ...(body.context_gates !== undefined ? { contextGates: body.context_gates } : {}),
    ...(body.fast_mode_cache_enabled !== undefined
      ? { fastModeCacheEnabled: body.fast_mode_cache_enabled }
      : {}),
    ...(body.world_model_mode !== undefined ? { worldModelMode: body.world_model_mode } : {}),
  });
}
/* c8 ignore stop */

/** Run phase 2 — Promise.allSettled of workflow starts. Marks failed rows
 *  FAILED in the DB and returns the per-child result map. */
async function runPhaseTwoStarts(
  newBodies: CreateAgentBody[],
  userId: string,
  verifierType: string
): Promise<Map<string, BatchAgentResult>> {
  const startResults = await Promise.allSettled(
    newBodies.map((body) => startBatchWorkflow(body, userId, verifierType))
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
    const errMsg =
      settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
    log.error('Batch workflow start failed', { agent_id: agentId, error: errMsg });
    await repo
      .failAgentIfStillActive(agentId, 'Failed to start workflow: ' + errMsg)
      .catch((e: unknown) =>
        log.error('Failed to mark agent FAILED after workflow-start error', {
          agent_id: agentId,
          error: e instanceof Error ? e.message : String(e),
        })
      );
    out.set(agentId, {
      agent_id: agentId,
      status: 'FAILED',
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

async function applyExecutionModeInheritanceForBatch(bodies: CreateAgentBody[]): Promise<void> {
  const parentIds = Array.from(
    new Set(
      bodies
        .filter(
          (body) =>
            body.parent_agent_id !== undefined &&
            (body.fast_mode_cache_enabled === undefined || body.world_model_mode === undefined)
        )
        .map((body) => body.parent_agent_id!)
    )
  );
  if (parentIds.length === 0) return;

  const parents = await repo.findExecutionModeFlagsByIds(parentIds);
  const parentById = new Map(parents.map((parent) => [parent.id, parent]));
  for (const body of bodies) {
    if (body.parent_agent_id === undefined) continue;
    const parent = parentById.get(body.parent_agent_id);
    applyFastModeInheritance(body, parent?.fastModeCacheEnabled);
    applyWorldModelModeInheritance(body, parent?.worldModelMode);
    disableFastModeForWorldModel(body);
  }
}

export async function createAgentsBatch(args: BatchCreateAgentsArgs): Promise<BatchAgentResult[]> {
  const { bodies, userId, isInternal, clientIP } = args;
  const verifierType = 'FLOAT_LLM_JUDGE';

  if (isInternal) {
    for (const body of bodies) body.goal = resolvePromptSecrets(body.goal);
  }
  for (const body of bodies) applyFastModeDefault(body, userId);
  await applyExecutionModeInheritanceForBatch(bodies);
  for (const body of bodies) disableFastModeForWorldModel(body);

  // Idempotency: existing rows are returned untouched.
  const allAgentIds = bodies.map((b) => b.agent_id!);
  const existing = await repo.findExistingAgentsByIds(allAgentIds, userId);
  const existingById = new Map(existing.map((a) => [a.id, a]));

  const newBodies = bodies.filter((b) => !existingById.has(b.agent_id!));
  const metaMap = await resolveAllMetadata(newBodies, clientIP, userId);
  const newItems = newBodies.map((b) => buildBatchItem(b, userId, metaMap.get(b)!, verifierType));

  if (newItems.length > 0) {
    // Phase 1: atomic create. Rolls back on any error.
    await repo.createAgentBatchTransaction(newItems);
  }

  // Phase 2: parallel workflow starts (with built-in gRPC retry).
  const newResultByAgentId = await runPhaseTwoStarts(newBodies, userId, verifierType);

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
