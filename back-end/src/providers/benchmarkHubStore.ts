import {
  BenchmarkHubConflictError,
  BenchmarkHubInvalidRecordError,
  BenchmarkHubUnavailableError,
} from './benchmarkHubErrors';
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
import { getRunBundleStrict, parseRunCatalog } from './benchmarkHubRunBundles';
import { coalesceHubRunPuts } from './benchmarkHubInFlight';
import {
  assertHubStorageOwnership,
  HUB_SQL_TIMEOUT_MS,
  withHubStorageOwnership,
} from './benchmarkHubStorageOwnership';
import {
  finiteMetric,
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
  beginHubPublications,
  hubOverlayEnabled,
  hubStorageDomain,
  hubWritesEnabled,
  bindHubLegacyBackfill,
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
export {
  getRunBundle,
  getRunBundleForAgentLookup,
  getRunBundleStrict,
  parseHubRunBundle,
} from './benchmarkHubRunBundles';
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

const INDEX_LOCK_KEY = `${hubStorageDomain()}:index`;
const indexAdmissionWaiters: Array<() => void> = [];
let indexAdmissionHeld = false;

/**
 * Serialize the shared index read-modify-write across every backend process.
 * The index lives in R2, so an in-memory mutex cannot prevent two Render or
 * local workspace processes from reading the same version and losing one
 * another's update. The transaction-scoped Postgres lock is released even
 * when an R2 operation throws.
 *
 * Each process admits its work in FIFO order. Uploads never queue here one by
 * one: each catalog cycle claims at most 64 queued uploads. A larger backlog
 * uses subsequent bounded cycles, sharing the catalog round trip per batch.
 * The shared SQL lock orders other processes' admitted writes.
 */
async function withIndexLock<T>(operation: () => Promise<T>, putCohort?: QueuedPut[]): Promise<T> {
  // A generic mutation is a FIFO barrier: later uploads belong to a new
  // cohort and must register admission after this operation.
  if (putCohort === undefined) openPutCohort = null;
  // Wait before borrowing a connection. Otherwise concurrent uploads occupy
  // the SQL pool while waiting for the same cross-process advisory lock.
  if (indexAdmissionHeld) {
    await new Promise<void>((resolve) => indexAdmissionWaiters.push(resolve));
  }
  indexAdmissionHeld = true;
  try {
    return await withHubStorageOwnership(() =>
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${INDEX_LOCK_KEY}))`;
          const result = await operation();
          assertHubStorageOwnership();
          return result;
        },
        // Locked work is bounded to the catalog, the compact index and one
        // bounded cycle of run bundles; index repair never scans the archive.
        { maxWait: 30_000, timeout: HUB_SQL_TIMEOUT_MS }
      )
    );
  } finally {
    // A rejected mutation remains rejected for its caller and hands admission
    // to the next waiter, just as PostgreSQL releases the transaction lock.
    const next = indexAdmissionWaiters.shift();
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
  if (!hubWritesEnabled())
    throw new BenchmarkHubUnavailableError(
      'Hub publication is paused pending storage epoch activation'
    );
  const runId = String(bundle.run_id ?? '');
  // Same allowlist as getRunBundle: the id becomes a filename in the local-dir
  // fallback, so anything outside it (e.g. "../../x") must never reach putObject.
  if (!/^[A-Za-z0-9._-]+$/.test(runId))
    throw new BenchmarkHubInvalidRecordError('bundle.run_id required (safe charset)');
  if (bundle.tasks !== undefined && !Array.isArray(bundle.tasks)) {
    throw new BenchmarkHubInvalidRecordError('Invalid Benchmark Hub run bundle');
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
  // A pre-agent registration retry must not replace progress that a peer
  // already committed for the same run (see applyQueuedPut).
  const startingRegistration =
    tasks.length > 0 && tasks.every((task) => task.status === 'starting') && agentIds.length === 0;

  const stored = await new Promise<StoredPut>((resolve, reject) => {
    const put: QueuedPut = {
      bundle,
      runId,
      tasks,
      summary,
      agentIds,
      startingRegistration,
      resolve,
      reject,
    };
    if (openPutCohort === null) {
      const cohort = [put];
      openPutCohort = cohort;
      void commitQueuedPuts(cohort);
    } else {
      openPutCohort.push(put);
      if (openPutCohort.length === PUT_CYCLE_LIMIT) openPutCohort = null;
    }
  });
  log.info('Stored benchmark run bundle', {
    runId,
    live: stored.summary.live,
    tasks: stored.summary.tasks.length,
  });
  if (stored.revision !== null) await slotHubAncestorSkeletonsFromBundle(bundle);
  return stored.summary;
}

type StoredPut = { summary: HubRunSummary; revision: number | null };
type QueuedPut = {
  bundle: Record<string, unknown>;
  runId: string;
  tasks: Array<Record<string, unknown>>;
  summary: HubRunSummary;
  agentIds: string[];
  startingRegistration: boolean;
  resolve: (stored: StoredPut) => void;
  reject: (error: unknown) => void;
};
type PutCycle = { index: HubRunSummary[]; agentIndex: HubAgentRunIndexSnapshot | null };

let openPutCohort: QueuedPut[] | null = null;
// One cycle's locked work stays bounded; later uploads take the next cycle.
const PUT_CYCLE_LIMIT = 64;
const PUT_WRITE_LANES = 8;

/**
 * Group commit for the single catalog writer. Uploads that queue while the
 * writer is busy share one catalog/agent-index read-modify-write, so a burst of
 * N uploads costs about two catalog cycles instead of N. Each catalog round
 * trip moves the whole archive index (7.7 MB in production on 2026-10-12, about
 * 3 s per cycle), so per-upload cycles capped the Hub at ~20 writes a minute
 * and a 40-controller terminal burst outlived the clients' response window.
 * Uploads apply in arrival order against the cycle's evolving state; a
 * validation error rejects only its own upload. A storage failure rejects the
 * whole cycle, whose catalog was not published.
 */
async function commitQueuedPuts(cycle: QueuedPut[]): Promise<void> {
  try {
    const outcomes = await withIndexLock(async () => {
      if (openPutCohort === cycle) openPutCohort = null;
      return commitPutCycle(cycle);
    }, cycle);
    // Object writes alone do not establish a successful SQL commit. Publish
    // cache state and caller acknowledgements only after the transaction joins.
    for (const { put, stored } of outcomes) {
      if (stored.revision !== null) {
        applyHubRunToResolutionCaches(put.runId, put.agentIds, stored.revision);
      }
      put.resolve(stored);
    }
  } catch (error: unknown) {
    if (openPutCohort === cycle) openPutCohort = null;
    for (const put of cycle) put.reject(error);
  }
}

async function commitPutCycle(
  queued: QueuedPut[]
): Promise<Array<{ put: QueuedPut; stored: StoredPut }>> {
  if (queued.length === 0) return [];
  const committed = await listRunsStrict();
  const cycle: PutCycle = {
    index: committed,
    agentIndex: await readAgentRunIndexForMutation(committed),
  };
  const outcomes: Array<{ put: QueuedPut; stored: StoredPut }> = [];
  // Bodies serialize inside the write lanes, so a cycle holds at most
  // PUT_WRITE_LANES serialized copies of large bundles at once.
  const bundles: Array<[string, Record<string, unknown>]> = [];
  for (const put of queued) {
    let summary: HubRunSummary | null;
    try {
      summary = applyQueuedPut(put, cycle);
    } catch (error: unknown) {
      put.reject(error);
      continue;
    }
    if (summary !== null) {
      outcomes.push({ put, stored: { summary, revision: null } });
      continue;
    }
    cycle.agentIndex = hubAgentIndexAfterPut(
      cycle.agentIndex,
      cycle.index.length === 0,
      put.runId,
      put.agentIds
    );
    cycle.index = [put.summary, ...cycle.index.filter((r) => r.run_id !== put.runId)];
    const fields = runGroupFields({ ...put.summary, run_id: put.runId });
    bundles.push([put.runId, { ...put.bundle, tasks: put.tasks, ...fields }]);
    outcomes.push({
      put,
      stored: { summary: put.summary, revision: cycle.agentIndex.revision },
    });
  }
  if (bundles.length > 0) {
    const writes = new Map<string, Array<Record<string, unknown>>>();
    for (const [runId, body] of bundles) writes.set(runId, [...(writes.get(runId) ?? []), body]);
    await beginHubPublications([...writes.keys()]);
    // Each run keeps its own upload order; distinct runs write concurrently.
    await inLanes([...writes], async ([runId, bodies]) => {
      for (const body of bodies) await putObject(`runs/${runId}.json`, JSON.stringify(body));
    });
    const next = [...cycle.index];
    next.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    const agentIndex = cycle.agentIndex!;
    await writeAgentRunIndex(agentIndex);
    await inLanes([...writes.keys()], (runId) => putObject(`visibility/${runId}.json`, 'true'));
    await putObject('index.json', JSON.stringify(next));
  }
  log.info('Staged Benchmark Hub upload cycle', {
    uploads: queued.length,
    stored: bundles.length,
    absorbed: outcomes.length - bundles.length,
    rejected: queued.length - outcomes.length,
  });
  return outcomes;
}

/** Bounded concurrent writes; stops claiming items after the first failure. */
async function inLanes<T>(items: T[], write: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await write(item);
      } catch (error: unknown) {
        failed = true;
        throw error;
      }
    }
  };
  const lanes = Array.from({ length: Math.min(PUT_WRITE_LANES, items.length) }, lane);
  for (const result of await Promise.allSettled(lanes)) {
    if (result.status === 'rejected') throw result.reason;
  }
}

/**
 * Validate one upload against the cycle's current catalog. Returns the existing
 * summary when the upload is absorbed, or null when it should be stored.
 */
function applyQueuedPut(put: QueuedPut, cycle: PutCycle): HubRunSummary | null {
  const { bundle, runId, tasks, summary, startingRegistration } = put;
  const existing = cycle.index.find((run) => run.run_id === runId);
  if (existing?.run_group || summary.run_group) {
    if ((existing && !existing.run_group) || (existing?.run_group && !summary.run_group)) {
      throw new BenchmarkHubConflictError('Benchmark Hub group ID collides with a physical run');
    }
    if (
      existing?.run_group &&
      (JSON.stringify(existing.run_group.members) !== JSON.stringify(summary.run_group!.members) ||
        existing.timestamp !== summary.timestamp)
    ) {
      throw new BenchmarkHubConflictError('Benchmark Hub group schedule changed');
    }
    if (summary.run_group) {
      const scheduled = new Map(
        summary.run_group.members.map((member) => [member.member_id, member])
      );
      for (const child of cycle.index.filter((run) => run.group_run_id === runId)) {
        const member = scheduled.get(child.group_member_id!);
        if (
          !member ||
          member.run_number !== child.group_run_number ||
          child.tasks.length !== 1 ||
          child.tasks[0]?.name !== member.name ||
          summary.run_group.members.length !== child.group_total
        ) {
          throw new BenchmarkHubConflictError(
            'Existing Benchmark Hub child differs from its group schedule'
          );
        }
      }
    }
  }
  if (!summary.run_group && cycle.index.some((run) => run.group_run_id === runId)) {
    throw new BenchmarkHubConflictError('Benchmark Hub group ID collides with a physical run');
  }
  if (existing?.group_run_id) {
    for (const field of HUB_GROUP_FIELDS) {
      if (
        summary[field] !== undefined &&
        summary[field] !== (field === 'group_attempt' ? (existing[field] ?? 1) : existing[field])
      ) {
        throw new BenchmarkHubConflictError('Benchmark Hub group membership changed');
      }
    }
    Object.assign(summary, runGroupFields({ ...existing, run_id: runId }));
  }
  if (summary.group_run_id) {
    const owner = cycle.index.find((run) => run.run_id === summary.group_run_id);
    if (owner && !owner.run_group)
      throw new BenchmarkHubConflictError('Benchmark Hub group ID collides with a physical run');
    validateGroupAttempt(summary, cycle.index, existing);
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
        throw new BenchmarkHubConflictError('Benchmark Hub group member differs from its schedule');
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
            ].map((field) => [field, finiteMetric((bundle.cost as Record<string, unknown>)[field])])
          )
        : null;
  }
  // Final is an absorbing state. A snapshot loop already in flight may
  // arrive after completion; it must not regress either the bundle or index
  // back to live/running.
  if (existing !== undefined && !existing.live && summary.live) return existing;
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
      Array.from(cycle.agentIndex?.agents.values() ?? []).includes(runId))
  ) {
    return existing;
  }
  return null;
}

/**
 * Persist the one-time legacy backfill. Concurrent uploads win for reused ids,
 * and pointers to runs deleted during the scan are discarded.
 */
export async function persistHubAgentRunBackfill(
  backfilled: Map<string, string>,
  scanStartRevision?: number,
  legacyStamp?: string
): Promise<HubAgentRunIndexSnapshot> {
  return withIndexLock(async () => {
    const runs = await listRunsStrict();
    const current = await readAgentRunIndexForMutation(runs);
    const snapshot = completedHubAgentBackfill(current, backfilled, runs, scanStartRevision);
    if (snapshot.complete) await bindHubLegacyBackfill(legacyStamp);
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
    if (hubOverlayEnabled())
      throw new BenchmarkHubUnavailableError('Hub catalog is temporarily unavailable');
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

/** Mutations and migrations must distinguish a missing catalog from read/corruption faults. */
export async function listRunsStrict(): Promise<HubRunSummary[]> {
  const raw = await getObjectStrict('index.json');
  return raw === null ? [] : parseRunCatalog(raw);
}

/**
 * Remove a run from the index (bundle object is left in place — index removal
 * hides it everywhere; object lifecycle is handled by bucket retention).
 * Returns false when the run id was not present.
 */
export async function deleteRun(runId: string): Promise<boolean> {
  if (!hubWritesEnabled())
    throw new BenchmarkHubUnavailableError(
      'Hub publication is paused pending storage epoch activation'
    );
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
            bundle: await getRunBundleStrict(run.run_id, run),
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
    if (agentIndex !== null) await writeAgentRunIndex(agentIndex);
    await putObject('index.json', JSON.stringify(next));
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
