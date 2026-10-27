/**
 * Planner memory service — search, lazy critical-path cache fill, stats.
 */

import * as repo from './repo';
import type {
  PlannerMemoryCompressionClaimBody,
  PlannerMemoryCompressionReleaseBody,
  PlannerMemoryCriticalPathBody,
  PlannerMemoryEmbedPendingBody,
  PlannerMemorySearchBody,
  PlannerMemoryUpsertBody,
  PlannerMemoryJson,
} from './types';

export async function search(body: PlannerMemorySearchBody) {
  const candidates = await repo.searchPlannerMemories({
    goal: body.goal,
    userId: body.user_id ?? null,
    excludeRootAgentId: body.exclude_root_agent_id ?? null,
    limit: body.limit,
    passedOnly: body.passed_only,
    minSimilarity: body.min_similarity,
  });
  return { candidates };
}

export async function upsert(id: string, body: PlannerMemoryUpsertBody) {
  await repo.upsertPlannerMemoryFromRun({
    rootAgentId: id,
    userId: body.user_id ?? null,
    goal: body.goal,
    benchmarkTaskName: body.benchmark_task_name ?? null,
    rootStatus: body.root_status ?? null,
    passed: body.passed ?? null,
    worldModelMode: body.world_model_mode ?? 'real',
    agentCreatedAt: body.agent_created_at ?? null,
  });
  if (body.critical_path !== undefined && body.critical_path !== null) {
    await repo.setPlannerMemoryCriticalPath(
      id,
      body.critical_path as PlannerMemoryJson,
      body.compressor_version ?? 'fixture'
    );
  }
  // Internal writers (benchmark fixtures, backfill) get a searchable row on return.
  await repo.embedPlannerMemory(id);
  return repo.findPlannerMemory(id);
}

export async function setCriticalPath(id: string, body: PlannerMemoryCriticalPathBody) {
  const updated = await repo.setPlannerMemoryCriticalPath(
    id,
    body.critical_path as PlannerMemoryJson,
    body.compressor_version,
    body.lease_id
  );
  return updated ? repo.findPlannerMemory(id) : null;
}

export async function claimCompression(id: string, body: PlannerMemoryCompressionClaimBody) {
  const claim = await repo.claimPlannerMemoryCompression(id, body.compressor_version);
  return claim.claimed
    ? { claimed: true, lease_id: claim.leaseId }
    : {
        claimed: false,
        reason: claim.reason,
        critical_path: claim.criticalPath,
        compressor_version: claim.compressorVersion,
      };
}

export async function releaseCompression(id: string, body: PlannerMemoryCompressionReleaseBody) {
  return repo.releasePlannerMemoryCompression(id, body.lease_id);
}

export async function remove(id: string) {
  return repo.deletePlannerMemory(id);
}

/** Non-internal callers see their own rows and ownerless benchmark fixtures. */
export const visibleTo = repo.plannerMemoryVisibleTo;

export async function get(id: string) {
  return repo.findPlannerMemory(id);
}

export async function stats() {
  return repo.plannerMemoryStats();
}

export async function embedPending(body: PlannerMemoryEmbedPendingBody) {
  return repo.embedPendingPlannerMemories(body.limit ?? 50);
}
