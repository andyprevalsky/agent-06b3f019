/**
 * Benchmark Hub run storage — uploaded benchmark run bundles + a run index.
 *
 * Layout (R2, reusing the trace-archive bucket + credentials under a
 * `benchmark-hub/` prefix; falls back to a local directory when R2 is not
 * configured, e.g. dev workspaces):
 *
 *   benchmark-hub/index.json          — array of run summaries (newest first)
 *   benchmark-hub/agent-run-index.json — compact agent-id → run-id lookup
 *   benchmark-hub/runs/<run_id>.json  — full run bundle (cloudbench-run.json
 *                                       shape: tasks[] with logs.messages and
 *                                       logs.tree from the full-tree copy-down)
 *
 * The same putRun() accepts live snapshots (status: "running", re-upserted as
 * the run progresses) and the final bundle, so the hub UI shows current runs
 * and completed runs through one index.
 */

import { ADMIN_USER_IDS } from '../utils/adminAccess';
import {
  deleteHubAncestorSkeletonsFromBundle,
  slotHubAncestorSkeletonsFromBundle,
} from './benchmarkHubAncestors';
import {
  completedHubAgentBackfill,
  hubAgentIndexAfterDelete,
  hubAgentIndexAfterPut,
  parseHubAgentRunIndex,
  parseHubAgentRunIndexRevision,
  rebuildHubAgentRunIndexWithExtractor,
  recoverableHubAgentRunRevision,
  type HubAgentRunIndexDocument,
  type HubAgentRunIndexRevisionDocument,
  type HubAgentRunIndexSnapshot,
} from './benchmarkHubAgentIndex';
import {
  agentIdsFromHubBundle,
  applyHubRunToResolutionCaches,
  forgetHubRunFromResolutionCaches,
  __resetHubResolutionCachesForTest,
} from './benchmarkHubLookup';
import { BenchmarkHubUnavailableError } from './benchmarkHubErrors';
import { coalesceHubRunPuts } from './benchmarkHubInFlight';
import {
  finiteMetric,
  normalizeAgentId,
  taskSummary,
  groupedRunCatalog,
  HUB_GROUP_FIELDS,
  HUB_GROUP_PAGE_SIZE,
  runGroupFields,
  runGroupSchedule,
} from './benchmarkHubRunProjection';
import {
  getObject,
  getObjectStrict,
  putObject,
  resetHubObjectStorageForTests,
} from './benchmarkHubStorage';
import type { HubRunSummary } from './benchmarkHubTypes';
import { prisma } from './database';
import { createLogger } from './logger';

export {
  agentIdsFromHubBundle,
  ancestorsFromHubTree,
  applyHubRunToResolutionCaches,
  backfillHubAgentRunIndex,
  backfillHubAgentRunIndexFromCatalog,
  findAgentAcrossRuns,
  findAncestorsAcrossRuns,
  findTreeAcrossRuns,
  forgetHubRunFromResolutionCaches,
  installHubAgentRunIndex,
  legacyBackfillRetryDelayMs,
  loadCompactHubAgentIndex,
  peekHubResolutionForTest,
  resolveHubRunIdFromIndexes,
  resolveHubRunIdFromAgentIndex,
  __resetHubResolutionCachesForTest,
} from './benchmarkHubLookup';
export {
  completedHubAgentBackfill,
  hubAgentIndexAfterDelete,
  hubAgentIndexAfterPut,
  parseHubAgentRunIndex,
  parseHubAgentRunIndexRevision,
  recoverableHubAgentRunRevision,
  type HubAgentRunIndexSnapshot,
} from './benchmarkHubAgentIndex';
export { canonicalAgentTree, getRunAgent, subtreeAgentsForBus } from './benchmarkHubView';
export { getRunDetail } from './benchmarkHubRunDetail';
export type {
  HubAgentView,
  HubRunCost,
  HubRunDetail,
  HubRunSummary,
  HubRunTaskDetail,
  HubRunTaskSummary,
} from './benchmarkHubTypes';

const log = createLogger('BenchmarkHubStore');

const AGENT_RUN_INDEX_KEY = 'agent-run-index.json';
const AGENT_RUN_INDEX_REVISION_KEY = 'agent-run-index-revision.json';

/**
 * Benchmark Hub access allowlist: hub reads/edits/dispatch and the benchmark-
 * agent fallback on the normal agent APIs are internal-team tooling. Mirrors
 * the front-end ADMIN_USER_IDS (terminal-component-group/config.ts).
 */
export const BENCHMARK_HUB_ADMIN_USER_IDS = ADMIN_USER_IDS;

/** Internal API key or an allowlisted team member may read the benchmark
 * archive through the normal agent APIs. */
export function canReadBenchmarkArchive(req: { isInternal?: boolean; userId?: string }): boolean {
  if (req.isInternal === true) return true;
  return req.userId !== undefined && BENCHMARK_HUB_ADMIN_USER_IDS.has(req.userId);
}

export function hubRunVisibleFromMarker(marker: string | null): boolean {
  return marker === null || marker === 'true';
}

async function readAgentRunIndexStrict(): Promise<HubAgentRunIndexSnapshot | null> {
  const [rawIndex, rawRevision] = await Promise.all([
    getObjectStrict(AGENT_RUN_INDEX_KEY),
    getObjectStrict(AGENT_RUN_INDEX_REVISION_KEY),
  ]);
  const index = parseHubAgentRunIndex(rawIndex);
  const durableRevisionFloor = parseHubAgentRunIndexRevision(rawRevision);
  if (index === null) {
    if (durableRevisionFloor === 0) return null;
    throw new Error('Benchmark Hub agent-run index is missing above its revision floor');
  }
  if (index.revision < durableRevisionFloor) {
    throw new Error('Benchmark Hub agent-run index trails its durable revision floor');
  }
  return index;
}

async function writeAgentRunIndex(index: HubAgentRunIndexSnapshot): Promise<void> {
  const revision: HubAgentRunIndexRevisionDocument = {
    version: 1,
    revision: index.revision,
  };
  const document: HubAgentRunIndexDocument = {
    version: 1,
    revision: index.revision,
    complete: index.complete,
    agents: Object.fromEntries(index.agents),
  };
  // Advance the separate floor first. If the following index write fails, the
  // next locked mutation allocates above it rather than publishing a revision
  // that an already-ahead replica would reject.
  await putObject(AGENT_RUN_INDEX_REVISION_KEY, JSON.stringify(revision));
  await putObject(AGENT_RUN_INDEX_KEY, JSON.stringify(document));
}

export async function rebuildHubAgentRunIndex(
  index: HubRunSummary[],
  loadBundle: (runId: string) => Promise<Record<string, unknown>>,
  durableRevisionFloor: number
): Promise<HubAgentRunIndexSnapshot> {
  return rebuildHubAgentRunIndexWithExtractor(
    index,
    loadBundle,
    durableRevisionFloor,
    agentIdsFromHubBundle
  );
}

/** Locked mutations repair malformed/partially-written indexes before changing state. */
async function readAgentRunIndexForMutation(
  authoritativeRuns: HubRunSummary[]
): Promise<HubAgentRunIndexSnapshot | null> {
  const [rawIndex, rawRevision] = await Promise.all([
    getObjectStrict(AGENT_RUN_INDEX_KEY),
    getObjectStrict(AGENT_RUN_INDEX_REVISION_KEY),
  ]);
  let revisionFloorMalformed = false;
  let parsedRevisionFloor: number;
  try {
    parsedRevisionFloor = parseHubAgentRunIndexRevision(rawRevision);
  } catch {
    revisionFloorMalformed = true;
    parsedRevisionFloor = recoverableHubAgentRunRevision(rawRevision);
  }
  const durableRevisionFloor = Math.max(
    parsedRevisionFloor,
    recoverableHubAgentRunRevision(rawIndex)
  );
  try {
    if (revisionFloorMalformed) {
      throw new Error('Benchmark Hub agent-run revision floor is malformed');
    }
    const parsed = parseHubAgentRunIndex(rawIndex);
    if (parsed === null) {
      if (durableRevisionFloor === 0) return null;
      throw new Error('Benchmark Hub agent-run index is missing above its revision floor');
    }
    if (parsed.revision < durableRevisionFloor) {
      throw new Error('Benchmark Hub agent-run index trails its durable revision floor');
    }
    return parsed;
  } catch (error: unknown) {
    log.warn('Rebuilding malformed Benchmark Hub agent-run index during locked mutation', {
      error: error instanceof Error ? error.message : String(error),
      durableRevisionFloor,
      runs: authoritativeRuns.length,
    });
    return rebuildHubAgentRunIndex(authoritativeRuns, getRunBundleStrict, durableRevisionFloor);
  }
}

/** Read one committed compact snapshot, sharing the multi-object writer boundary. */
export async function loadHubAgentRunIndex(): Promise<HubAgentRunIndexSnapshot | null> {
  return withIndexLock(readAgentRunIndexStrict);
}

/** A small exact-key tombstone keeps stale per-process maps from serving deleted runs. */
export async function isHubRunVisible(runId: string): Promise<boolean | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return false;
  try {
    const marker = await getObjectStrict(`visibility/${runId}.json`);
    return hubRunVisibleFromMarker(marker);
  } catch (error: unknown) {
    log.warn('Benchmark Hub visibility read is temporarily unknown', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const INDEX_LOCK_KEY = 'benchmark-hub:index';
type IndexAdmission = 'foreground' | 'snapshot';
const indexAdmissionWaiters: Record<IndexAdmission, Array<() => void>> = {
  foreground: [],
  snapshot: [],
};
let indexAdmissionHeld = false;

/**
 * Serialize the shared index read-modify-write across every backend process.
 * The index lives in R2, so an in-memory mutex cannot prevent two Render or
 * local workspace processes from reading the same version and losing one
 * another's update. The transaction-scoped Postgres lock is released even
 * when an R2 operation throws.
 *
 * Live snapshots are superseded by the run's next snapshot, while a final
 * bundle, delete or index read is one-shot. Queued foreground work is admitted
 * ahead of queued snapshots, so a fleet's snapshot stream saturating this
 * single writer cannot starve the final upload behind every pending snapshot.
 */
async function withIndexLock<T>(
  operation: () => Promise<T>,
  admission: IndexAdmission = 'foreground'
): Promise<T> {
  // Wait before borrowing a connection. Otherwise concurrent uploads occupy
  // the SQL pool while waiting for the same cross-process advisory lock.
  if (indexAdmissionHeld) {
    await new Promise<void>((resolve) => indexAdmissionWaiters[admission].push(resolve));
  }
  indexAdmissionHeld = true;
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${INDEX_LOCK_KEY}))`;
        return operation();
      },
      // A corruption-only repair may cooperatively read the entire archive while
      // holding this cross-process lock. Normal writes remain small, but the rare
      // repair must finish atomically rather than timing out at the old 30s limit.
      { maxWait: 30_000, timeout: 5 * 60_000 }
    );
  } finally {
    // A rejected mutation remains rejected for its caller and hands admission
    // to the next waiter, just as PostgreSQL releases the transaction lock.
    const next = indexAdmissionWaiters.foreground.shift() ?? indexAdmissionWaiters.snapshot.shift();
    if (next === undefined) indexAdmissionHeld = false;
    else next();
  }
}

/** Upsert a run bundle (live snapshot or final), returning the stored summary. */
export const putRun = coalesceHubRunPuts(storeRun);

async function storeRun(
  bundle: Record<string, unknown>,
  options: { live?: boolean; source?: string } = {}
): Promise<HubRunSummary> {
  const runId = String(bundle.run_id ?? '');
  // Same allowlist as getRunBundle: the id becomes a filename in the local-dir
  // fallback, so anything outside it (e.g. "../../x") must never reach putObject.
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('bundle.run_id required (safe charset)');
  const tasks = Array.isArray(bundle.tasks) ? (bundle.tasks as Array<Record<string, unknown>>) : [];
  const summary: HubRunSummary = {
    run_id: runId,
    timestamp: String(bundle.timestamp ?? new Date().toISOString()),
    suite: typeof bundle.suite === 'string' ? bundle.suite : null,
    source: options.source ?? (typeof bundle.source === 'string' ? bundle.source : null),
    live: options.live === true,
    uploaded_at: new Date().toISOString(),
    tasks: tasks.map(taskSummary),
    ...runGroupFields(bundle),
    ...(bundle.run_group !== undefined ? { run_group: runGroupSchedule(bundle) } : {}),
  };
  const agentIds = agentIdsFromHubBundle(bundle);

  let storedSummary = summary;
  let storedAgentIndexRevision: number | null = null;
  await withIndexLock(
    async () => {
      const index = await listRunsStrict();
      const existing = index.find((run) => run.run_id === runId);
      if (existing?.run_group || summary.run_group) {
        if ((existing && !existing.run_group) || (existing?.run_group && !summary.run_group)) {
          throw new Error('Benchmark Hub group ID collides with a physical run');
        }
        if (
          existing?.run_group &&
          JSON.stringify(existing.run_group.members) !== JSON.stringify(summary.run_group!.members)
        ) {
          throw new Error('Benchmark Hub group schedule changed');
        }
        if (summary.run_group) {
          const scheduled = new Map(
            summary.run_group.members.map((member) => [member.member_id, member])
          );
          for (const child of index.filter((run) => run.group_run_id === runId)) {
            const member = scheduled.get(child.group_member_id!);
            if (
              !member ||
              member.run_number !== child.group_run_number ||
              child.tasks.length !== 1 ||
              child.tasks[0]?.name !== member.name ||
              summary.run_group.members.length !== child.group_total
            ) {
              throw new Error('Existing Benchmark Hub child differs from its group schedule');
            }
          }
        }
      }
      if (!summary.run_group && index.some((run) => run.group_run_id === runId)) {
        throw new Error('Benchmark Hub group ID collides with a physical run');
      }
      if (existing?.group_run_id) {
        for (const field of HUB_GROUP_FIELDS) {
          if (summary[field] !== undefined && summary[field] !== existing[field]) {
            throw new Error('Benchmark Hub group membership changed');
          }
        }
        Object.assign(summary, runGroupFields({ ...existing, run_id: runId }));
      }
      if (summary.group_run_id) {
        const owner = index.find((run) => run.run_id === summary.group_run_id);
        if (owner && !owner.run_group)
          throw new Error('Benchmark Hub group ID collides with a physical run');
        if (
          index.some(
            (run) =>
              run.run_id !== runId &&
              run.group_run_id === summary.group_run_id &&
              run.group_member_id === summary.group_member_id
          )
        ) {
          throw new Error('Benchmark Hub group member already belongs to another run');
        }
        if (owner?.run_group) {
          const member = owner.run_group.members.find(
            (item) => item.member_id === summary.group_member_id
          );
          if (
            !member ||
            member.run_number !== summary.group_run_number ||
            tasks.length !== 1 ||
            tasks[0]?.name !== member.name ||
            owner.run_group.members.length !== summary.group_total
          ) {
            throw new Error('Benchmark Hub group member differs from its schedule');
          }
        }
        summary.tasks = tasks.map((task) => ({
          ...taskSummary(task),
          cost_cents: finiteMetric(task.cost_cents),
          duration_seconds: finiteMetric(task.duration_seconds),
          tree_agent_count: finiteMetric(task.tree_agent_count),
          tokens_in: finiteMetric(task.tokens_in),
          tokens_out: finiteMetric(task.tokens_out),
          cache_hit_pct: finiteMetric(task.cache_hit_pct),
          llm_call_count: finiteMetric(task.llm_call_count),
          message_count: finiteMetric(task.message_count),
        }));
        summary.code =
          typeof bundle.code === 'string' && bundle.code.length <= 128 ? bundle.code : null;
        summary.elapsed_s = finiteMetric(bundle.elapsed_s);
        summary.cost =
          typeof bundle.cost === 'object' && bundle.cost !== null
            ? Object.fromEntries(
                [
                  'agents_llm_usd',
                  'wmh_grounding_usd',
                  'infra_usd',
                  'total_usd',
                  'fast_cache_hit_rate',
                ].map((field) => [
                  field,
                  finiteMetric((bundle.cost as Record<string, unknown>)[field]),
                ])
              )
            : null;
      }
      // Final is an absorbing state. A snapshot loop already in flight may
      // arrive after completion; it must not regress either the bundle or index
      // back to live/running.
      if (existing !== undefined && !existing.live && summary.live) {
        storedSummary = existing;
        return;
      }
      const persisted = await readAgentRunIndexForMutation(index);
      const agentIndex = hubAgentIndexAfterPut(persisted, index.length === 0, runId, agentIds);
      await putObject(
        `runs/${runId}.json`,
        JSON.stringify({ ...bundle, ...runGroupFields({ ...summary, run_id: runId }) })
      );
      const next = [summary, ...index.filter((r) => r.run_id !== runId)];
      next.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      await putObject('index.json', JSON.stringify(next));
      await writeAgentRunIndex(agentIndex);
      await putObject(`visibility/${runId}.json`, 'true');
      storedAgentIndexRevision = agentIndex.revision;
    },
    summary.live ? 'snapshot' : 'foreground'
  );
  log.info('Stored benchmark run bundle', {
    runId,
    live: storedSummary.live,
    tasks: storedSummary.tasks.length,
  });
  if (storedAgentIndexRevision !== null) {
    await slotHubAncestorSkeletonsFromBundle(bundle);
    applyHubRunToResolutionCaches(runId, agentIds, storedAgentIndexRevision);
  }
  return storedSummary;
}

/**
 * Persist the one-time legacy backfill. Concurrent uploads win for reused ids,
 * and pointers to runs deleted during the scan are discarded.
 */
export async function persistHubAgentRunBackfill(
  backfilled: Map<string, string>
): Promise<HubAgentRunIndexSnapshot> {
  return withIndexLock(async () => {
    const runs = await listRunsStrict();
    const validRunIds = new Set(runs.map((run) => run.run_id));
    const current = await readAgentRunIndexForMutation(runs);
    const snapshot = completedHubAgentBackfill(current, backfilled, validRunIds);
    await writeAgentRunIndex(snapshot);
    return snapshot;
  });
}

export async function listRuns(options: { grouped?: boolean } = {}): Promise<HubRunSummary[]> {
  const raw = await getObject('index.json');
  if (!raw) return [];
  try {
    const runs = parseRunCatalog(raw);
    return options.grouped === true ? groupedRunCatalog(runs) : runs;
  } catch {
    return [];
  }
}

export async function listRunPage(page: { offset?: number; limit?: number } = {}): Promise<{
  runs: HubRunSummary[];
  pagination: { offset: number; limit: number; total: number };
}> {
  const runs = await listRuns({ grouped: true });
  const offset = Number.isInteger(page.offset) && page.offset! >= 0 ? page.offset! : 0;
  const limit =
    Number.isInteger(page.limit) && page.limit! > 0
      ? Math.min(page.limit!, HUB_GROUP_PAGE_SIZE)
      : HUB_GROUP_PAGE_SIZE;
  return {
    runs: runs.slice(offset, offset + limit),
    pagination: { offset, limit, total: runs.length },
  };
}

function parseRunCatalog(raw: string): HubRunSummary[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Invalid Benchmark Hub run catalog');
  return parsed.map((value) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Partial<HubRunSummary>).run_id !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test((value as Partial<HubRunSummary>).run_id as string) ||
      !Array.isArray((value as Partial<HubRunSummary>).tasks)
    ) {
      throw new Error('Invalid Benchmark Hub run catalog entry');
    }
    const run = value as HubRunSummary;
    return {
      ...run,
      tasks: run.tasks.map((task) => ({ ...task, agent_id: normalizeAgentId(task.agent_id) })),
    };
  });
}

/** Mutations and migrations must distinguish a missing catalog from read/corruption faults. */
export async function listRunsStrict(): Promise<HubRunSummary[]> {
  const raw = await getObjectStrict('index.json');
  return raw === null ? [] : parseRunCatalog(raw);
}

export async function getRunBundle(runId: string): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  const raw = await getObject(`runs/${runId}.json`);
  if (!raw) return null;
  try {
    return parseHubRunBundle(raw);
  } catch {
    return null;
  }
}

/** Agent resolution preserves transport faults so callers do not cache a false miss. */
export async function getRunBundleForAgentLookup(
  runId: string
): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  let raw: string | null;
  try {
    raw = await getObjectStrict(`runs/${runId}.json`);
  } catch (error: unknown) {
    log.warn('Benchmark Hub run bundle read is temporarily unavailable', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new BenchmarkHubUnavailableError(
      'Benchmark Hub run bundle is temporarily unavailable; retry shortly'
    );
  }
  if (raw === null) return null;
  try {
    return parseHubRunBundle(raw);
  } catch (error: unknown) {
    log.warn('Benchmark Hub run bundle is malformed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function parseHubRunBundle(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).tasks)
  ) {
    throw new Error('Invalid Benchmark Hub run bundle');
  }
  return parsed as Record<string, unknown>;
}

/** Legacy-index migration must distinguish an absent/corrupt bundle from success. */
export async function getRunBundleStrict(runId: string): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Invalid Hub run id: ${runId}`);
  const raw = await getObjectStrict(`runs/${runId}.json`);
  if (raw === null) throw new Error(`Missing Hub run bundle: ${runId}`);
  return parseHubRunBundle(raw);
}

/**
 * Remove a run from the index (bundle object is left in place — index removal
 * hides it everywhere; object lifecycle is handled by bucket retention).
 * Returns false when the run id was not present.
 */
export async function deleteRun(runId: string): Promise<boolean> {
  const retired: Array<{ runId: string; bundle: Record<string, unknown> }> = [];
  const removed = await withIndexLock(async () => {
    const index = await listRunsStrict();
    const targets = index.filter((run) => run.run_id === runId || run.group_run_id === runId);
    if (!targets.length) return false;
    // Validate every exact owned bundle before the catalog becomes invisible.
    for (let start = 0; start < targets.length; start += 4) {
      retired.push(
        ...(await Promise.all(
          targets.slice(start, start + 4).map(async (run) => ({
            runId: run.run_id,
            bundle: await getRunBundleStrict(run.run_id),
          }))
        ))
      );
    }
    const ids = new Set(targets.map((run) => run.run_id));
    const next = index.filter((run) => !ids.has(run.run_id));
    let agentIndex = await readAgentRunIndexForMutation(next);
    for (const target of targets) {
      await putObject(`visibility/${target.run_id}.json`, 'false');
      if (agentIndex !== null) agentIndex = hubAgentIndexAfterDelete(agentIndex, target.run_id);
    }
    await putObject('index.json', JSON.stringify(next));
    if (agentIndex !== null) await writeAgentRunIndex(agentIndex);
    return true;
  });
  if (removed)
    for (const target of retired) {
      await deleteHubAncestorSkeletonsFromBundle(target.bundle);
      forgetHubRunFromResolutionCaches(target.runId, agentIdsFromHubBundle(target.bundle));
    }
  return removed;
}

/** Test-only: reset in-process state (local dir is controlled by the caller). */
export function _resetForTests(): void {
  resetHubObjectStorageForTests();
  __resetHubResolutionCachesForTest();
}
