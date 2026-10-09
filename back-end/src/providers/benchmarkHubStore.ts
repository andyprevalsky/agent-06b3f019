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

import { validateGroupAttempt } from './benchmarkHubGroupAttempts';
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
  recoverableHubAgentRunRevision,
  salvagedHubAgentRunIndex,
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
  salvagedHubAgentRunIndex,
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
    ...(index.repairedRevision === undefined ? {} : { repaired_revision: index.repairedRevision }),
    agents: Object.fromEntries(index.agents),
  };
  // Advance the separate floor first. If the following index write fails, the
  // next locked mutation allocates above it rather than publishing a revision
  // that an already-ahead replica would reject.
  await putObject(AGENT_RUN_INDEX_REVISION_KEY, JSON.stringify(revision));
  await putObject(AGENT_RUN_INDEX_KEY, JSON.stringify(document));
}

/**
 * Locked mutations repair malformed/partially-written indexes before changing
 * state. The repair never rescans the archive: thousands of multi-megabyte
 * bundles cannot be read inside the writer lock, so one failed publication
 * would otherwise block every later write.
 */
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
    let persisted: HubAgentRunIndexSnapshot | null = null;
    try {
      persisted = parseHubAgentRunIndex(rawIndex);
    } catch {
      // A malformed document contributes only its salvaged revision.
    }
    log.warn('Repairing inconsistent Benchmark Hub agent-run index during locked mutation', {
      error: error instanceof Error ? error.message : String(error),
      durableRevisionFloor,
      salvagedAgents: persisted?.agents.size ?? 0,
      runs: authoritativeRuns.length,
    });
    return salvagedHubAgentRunIndex(persisted, authoritativeRuns, durableRevisionFloor);
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
 * bundle, delete or index read is one-shot. Each process admits its queued
 * foreground work ahead of its snapshots. The shared SQL lock still orders
 * other processes' already-admitted writes; it does not preempt those writes.
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
      // Locked work is bounded to the catalog, the compact index and one run
      // bundle; index repair never scans the archive under this lock.
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
  if (bundle.tasks !== undefined && !Array.isArray(bundle.tasks)) {
    throw new Error('Invalid Benchmark Hub run bundle');
  }
  // Every stored bundle carries a task list, so readers need no shape fallback.
  const tasks = (bundle.tasks ?? []) as Array<Record<string, unknown>>;
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
  // This one-shot registration must be visible before the caller can create
  // any agent; it cannot be replaced by an already-running progress stream.
  const startingRegistration =
    tasks.length > 0 && tasks.every((task) => task.status === 'starting') && agentIds.length === 0;

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
          (JSON.stringify(existing.run_group.members) !==
            JSON.stringify(summary.run_group!.members) ||
            existing.timestamp !== summary.timestamp)
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
          if (
            summary[field] !== undefined &&
            summary[field] !==
              (field === 'group_attempt' ? (existing[field] ?? 1) : existing[field])
          ) {
            throw new Error('Benchmark Hub group membership changed');
          }
        }
        Object.assign(summary, runGroupFields({ ...existing, run_id: runId }));
      }
      if (summary.group_run_id) {
        const owner = index.find((run) => run.run_id === summary.group_run_id);
        if (owner && !owner.run_group)
          throw new Error('Benchmark Hub group ID collides with a physical run');
        validateGroupAttempt(summary, index, existing);
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
      // An unknown-ACK registration retry can arrive after another process
      // has committed progress. Preserve that durable handoff; distinct
      // pre-agent starting packets may still update until ownership advances.
      if (
        existing !== undefined &&
        summary.live &&
        startingRegistration &&
        (existing.tasks.some(
          (task) =>
            (typeof task.status === 'string' && task.status !== 'starting') ||
            (typeof task.agent_id === 'string' && task.agent_id.length > 0)
        ) ||
          Array.from(persisted?.agents.values() ?? []).includes(runId))
      ) {
        storedSummary = existing;
        return;
      }
      const agentIndex = hubAgentIndexAfterPut(persisted, index.length === 0, runId, agentIds);
      await putObject(
        `runs/${runId}.json`,
        JSON.stringify({ ...bundle, tasks, ...runGroupFields({ ...summary, run_id: runId }) })
      );
      const next = [summary, ...index.filter((r) => r.run_id !== runId)];
      next.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
      await putObject('index.json', JSON.stringify(next));
      await writeAgentRunIndex(agentIndex);
      await putObject(`visibility/${runId}.json`, 'true');
      storedAgentIndexRevision = agentIndex.revision;
    },
    summary.live && !startingRegistration ? 'snapshot' : 'foreground'
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
  backfilled: Map<string, string>,
  scanStartRevision?: number
): Promise<HubAgentRunIndexSnapshot> {
  return withIndexLock(async () => {
    const runs = await listRunsStrict();
    const current = await readAgentRunIndexForMutation(runs);
    const snapshot = completedHubAgentBackfill(current, backfilled, runs, scanStartRevision);
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

/**
 * Strictly parse a stored run bundle. Writers before 2026-10 stored any
 * non-array task list verbatim and cataloged that run with zero tasks; only a
 * caller holding that zero-task catalog summary may read it as an empty run.
 */
export function parseHubRunBundle(
  raw: string,
  catalogSummary?: { tasks: unknown[] }
): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid Benchmark Hub run bundle');
  }
  const bundle = parsed as Record<string, unknown>;
  if (Array.isArray(bundle.tasks)) return bundle;
  if (catalogSummary?.tasks.length === 0) return { ...bundle, tasks: [] };
  throw new Error('Invalid Benchmark Hub run bundle');
}

/** Legacy-index migration must distinguish an absent/corrupt bundle from success. */
export async function getRunBundleStrict(
  runId: string,
  catalogSummary?: { tasks: unknown[] }
): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Invalid Hub run id: ${runId}`);
  const raw = await getObjectStrict(`runs/${runId}.json`);
  if (raw === null) throw new Error(`Missing Hub run bundle: ${runId}`);
  return parseHubRunBundle(raw, catalogSummary);
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
