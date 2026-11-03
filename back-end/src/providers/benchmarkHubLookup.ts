import { hubWritesEnabled, hubLegacyArchiveStamp } from './benchmarkHubStorage';
/**
 * O(1) hub agent-id resolution for GET /agents/:id.
 *
 * Official 4w creates a client UUID and reads the row before POST commits.
 * A per-request scan of every hub bundle on that miss starves Prisma.
 * Unknown IDs miss without reading the run catalog or any full bundle.
 * Uploads/deletes persist a compact reverse index; a bounded background refresh
 * and exact run tombstones keep per-process maps aligned across backend replicas.
 */
import {
  getRunBundleStrict,
  listRunsStrict,
  loadHubAgentRunIndex,
  persistHubAgentRunBackfill,
  type HubAgentView,
  type HubAgentRunIndexSnapshot,
  type HubRunSummary,
} from './benchmarkHubStore';
import { BenchmarkHubUnavailableError } from './benchmarkHubErrors';
import { canonicalAgentTree, getRunAgent, subtreeAgentsForBus } from './benchmarkHubView';
import { createLogger } from './logger';

const log = createLogger('BenchmarkHubLookup');
const AGENT_INDEX_REFRESH_MS = 5_000;
const LEGACY_BACKFILL_RETRY_BASE_MS = 5_000;
const LEGACY_BACKFILL_RETRY_MAX_MS = 5 * 60_000;
const agentRunCache = new Map<string, string>();
const agentRunMissCache = new Set<string>();
let childIdToRun: Map<string, string> | null = null;
let compactIndexLoadPromise: Promise<CompactIndexLoadResult> | null = null;
let compactIndexNonReady: Exclude<CompactIndexLoadResult, { kind: 'ready' }> | null = null;
let compactIndexRetryAt = 0;
let legacyBackfillPromise: Promise<void> | null = null;
let legacyBackfillFailureCount = 0;
let legacyBackfillRetryAt = 0;
let childIdIndexLoadedAt = 0;
let childIdIndexComplete = false;
let latestAppliedRevision = 0;
let installedCacheVersion: string | undefined;

export type CompactIndexLoadResult =
  | { kind: 'ready' }
  | { kind: 'legacy'; seed: Map<string, string>; revision: number }
  | { kind: 'stale' }
  | { kind: 'error' };

export function legacyBackfillRetryDelayMs(failureCount: number): number {
  const exponent = Math.max(0, Math.min(16, Math.floor(failureCount) - 1));
  return Math.min(LEGACY_BACKFILL_RETRY_MAX_MS, LEGACY_BACKFILL_RETRY_BASE_MS * 2 ** exponent);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Build the archived child-agent lookup without starving live HTTP requests. */
export async function buildHubAgentIdIndex(
  index: HubRunSummary[],
  loadBundle: (runId: string, summary: HubRunSummary) => Promise<Record<string, unknown> | null>,
  seed: Map<string, string> = new Map()
): Promise<Map<string, string>> {
  // The catalog is ordered by run timestamp, but a re-uploaded run can carry an
  // older timestamp. Scan newest upload first so the first run seen per agent
  // matches locked puts; seed mappings only fill agents the scan did not find.
  const byUpload = [...index].sort((a, b) => {
    const left = a.uploaded_at ?? '';
    const right = b.uploaded_at ?? '';
    return left < right ? 1 : left > right ? -1 : 0;
  });
  const map = new Map<string, string>();
  for (const run of byUpload) {
    // Local Hub bundles can exceed 50 MB and old workspaces can hold hundreds
    // of them. Yield before each async read/parse so this background migration
    // cannot monopolize the backend while a client-created agent UUID is still
    // racing its POST /api/agents commit.
    await yieldToEventLoop();
    const bundle = await loadBundle(run.run_id, run);
    if (bundle === null) continue;
    for (const id of agentIdsFromHubBundle(bundle)) {
      if (!map.has(id)) map.set(id, run.run_id);
    }
  }
  for (const [id, runId] of seed) {
    if (!map.has(id)) map.set(id, runId);
  }
  return map;
}

/** Failed bundle reads reject before the completion callback can publish the migration. */
export async function backfillHubAgentRunIndex(
  index: HubRunSummary[],
  loadBundle: (runId: string, summary: HubRunSummary) => Promise<Record<string, unknown> | null>,
  seed: Map<string, string>,
  persist: (agents: Map<string, string>) => Promise<HubAgentRunIndexSnapshot>
): Promise<HubAgentRunIndexSnapshot> {
  return persist(await buildHubAgentIdIndex(index, loadBundle, seed));
}

/** Catalog faults reject before a migration can publish complete=true. */
export async function backfillHubAgentRunIndexFromCatalog(
  loadRuns: () => Promise<HubRunSummary[]>,
  loadBundle: (runId: string, summary: HubRunSummary) => Promise<Record<string, unknown> | null>,
  seed: Map<string, string>,
  persist: (agents: Map<string, string>) => Promise<HubAgentRunIndexSnapshot>
): Promise<HubAgentRunIndexSnapshot> {
  return backfillHubAgentRunIndex(await loadRuns(), loadBundle, seed, persist);
}

/** Install one authoritative persisted revision and invalidate older hit/miss decisions. */
export function installHubAgentRunIndex(index: HubAgentRunIndexSnapshot): boolean {
  const oldDomain = installedCacheVersion?.split('|')[0];
  const newDomain = index.cacheVersion?.split('|')[0];
  if (oldDomain && newDomain && oldDomain !== newDomain) latestAppliedRevision = 0;
  if (index.revision < latestAppliedRevision) return false;
  installedCacheVersion = index.cacheVersion;
  childIdToRun = new Map(index.agents);
  childIdIndexComplete = index.complete;
  childIdIndexLoadedAt = Date.now();
  latestAppliedRevision = index.revision;
  agentRunCache.clear();
  agentRunMissCache.clear();
  return true;
}

/** The cold path awaits only this compact read; it never awaits full-bundle migration. */
export async function loadCompactHubAgentIndex(
  loadIndex: () => Promise<HubAgentRunIndexSnapshot | null> = loadHubAgentRunIndex
): Promise<CompactIndexLoadResult> {
  try {
    const persisted = await loadIndex();
    if (persisted !== null && !installHubAgentRunIndex(persisted)) return { kind: 'stale' };
    if (persisted === null || !persisted.complete) {
      return {
        kind: 'legacy',
        seed: persisted?.agents ?? new Map(),
        revision: persisted?.revision ?? 0,
      };
    }
    return { kind: 'ready' };
  } catch (error: unknown) {
    log.warn('Benchmark Hub compact agent index read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'error' };
  }
}

function startCompactIndexLoad(): Promise<CompactIndexLoadResult> {
  if (compactIndexLoadPromise !== null) return compactIndexLoadPromise;
  if (compactIndexNonReady !== null && Date.now() < compactIndexRetryAt) {
    return Promise.resolve(compactIndexNonReady);
  }
  compactIndexLoadPromise = loadCompactHubAgentIndex()
    .then((result) => {
      // A failed cold read has no installed map to supply the normal freshness
      // window. Bound retries independently of incoming agent request volume.
      compactIndexNonReady = result.kind === 'ready' ? null : result;
      compactIndexRetryAt = result.kind === 'ready' ? 0 : Date.now() + AGENT_INDEX_REFRESH_MS;
      return result;
    })
    .finally(() => {
      compactIndexLoadPromise = null;
    });
  return compactIndexLoadPromise;
}

function scheduleLegacyBackfill(seed: Map<string, string>, seedRevision: number): void {
  if (!hubWritesEnabled()) return;
  if (legacyBackfillPromise !== null || Date.now() < legacyBackfillRetryAt) return;
  // Archives created before agent-run-index.json need exactly one cooperative
  // backfill. Persisting complete=true makes later process starts independent
  // of archive size; foreground requests never await this migration.
  legacyBackfillPromise = (async () => {
    const legacyStamp = await hubLegacyArchiveStamp();
    const stored = await backfillHubAgentRunIndexFromCatalog(
      listRunsStrict,
      getRunBundleStrict,
      seed,
      (agents) => persistHubAgentRunBackfill(agents, seedRevision, legacyStamp)
    );
    installHubAgentRunIndex(stored);
    legacyBackfillFailureCount = 0;
    legacyBackfillRetryAt = 0;
  })()
    .catch((error: unknown) => {
      legacyBackfillFailureCount += 1;
      const retryDelayMs = legacyBackfillRetryDelayMs(legacyBackfillFailureCount);
      legacyBackfillRetryAt = Date.now() + retryDelayMs;
      log.warn('Benchmark Hub legacy agent index backfill failed', {
        error: error instanceof Error ? error.message : String(error),
        retryDelayMs,
      });
    })
    .finally(() => {
      legacyBackfillPromise = null;
    });
}

function scheduleCompactIndexRefresh(): void {
  const fresh = childIdToRun !== null && Date.now() - childIdIndexLoadedAt < AGENT_INDEX_REFRESH_MS;
  if (fresh || compactIndexLoadPromise !== null || Date.now() < compactIndexRetryAt) return;
  void startCompactIndexLoad().then((result) => {
    if (result.kind === 'legacy') scheduleLegacyBackfill(result.seed, result.revision);
  });
}

function rememberHubRun(agentId: string, runId: string): void {
  agentRunCache.set(agentId, runId);
  agentRunMissCache.delete(agentId);
}

/** Agent ids in a hub bundle (task roots + tree nodes). */
export function agentIdsFromHubBundle(bundle: { tasks?: unknown }): string[] {
  const ids: string[] = [];
  const tasks = Array.isArray(bundle.tasks) ? bundle.tasks : [];
  for (const task of tasks) {
    const record = task as { agent_id?: unknown; logs?: { tree?: unknown } };
    if (typeof record.agent_id === 'string' && record.agent_id.length > 0) {
      ids.push(record.agent_id);
    }
    ids.push(...Object.keys(canonicalAgentTree(record.logs?.tree)));
  }
  return [...new Set(ids)];
}

/** Newest upload wins for a reused bench agent id; miss cache cannot pin a stale 404. */
export function applyHubRunToResolutionCaches(
  runId: string,
  agentIds: string[],
  revision?: number
): void {
  if (revision !== undefined && revision < latestAppliedRevision) return;
  if (revision !== undefined) latestAppliedRevision = revision;
  for (const id of agentIds) {
    if (!id) continue;
    if (childIdToRun !== null) childIdToRun.set(id, runId);
    rememberHubRun(id, runId);
  }
}

/** Index removal hides a run; drop resolution entries that still point at it. */
export function forgetHubRunFromResolutionCaches(runId: string, agentIds: string[]): void {
  for (const id of agentIds) {
    if (childIdToRun?.get(id) === runId) childIdToRun.delete(id);
    if (agentRunCache.get(id) === runId) agentRunCache.delete(id);
  }
}

export function __resetHubResolutionCachesForTest(): void {
  agentRunCache.clear();
  agentRunMissCache.clear();
  childIdToRun = null;
  compactIndexLoadPromise = null;
  compactIndexNonReady = null;
  compactIndexRetryAt = 0;
  legacyBackfillPromise = null;
  legacyBackfillFailureCount = 0;
  legacyBackfillRetryAt = 0;
  childIdIndexLoadedAt = 0;
  childIdIndexComplete = false;
  latestAppliedRevision = 0;
  installedCacheVersion = undefined;
}

export function peekHubResolutionForTest(agentId: string): {
  cachedRunId: string | undefined;
  childRunId: string | undefined;
} {
  return {
    cachedRunId: agentRunCache.get(agentId),
    childRunId: childIdToRun?.get(agentId),
  };
}

/** Legacy pure helper for callers that already hold both old indexes. */
export function resolveHubRunIdFromIndexes(
  agentId: string,
  runs: HubRunSummary[],
  childIndex: Map<string, string> | null
): { kind: 'hit'; runId: string } | { kind: 'miss' } | { kind: 'pending' } {
  for (const run of runs) {
    if (run.tasks.some((task) => task.agent_id === agentId)) {
      return { kind: 'hit', runId: run.run_id };
    }
  }
  if (childIndex === null) return { kind: 'pending' };
  const runId = childIndex.get(agentId);
  return runId === undefined ? { kind: 'miss' } : { kind: 'hit', runId };
}

/** Constant-time lookup once the compact persisted index is loaded. */
export function resolveHubRunIdFromAgentIndex(
  agentId: string,
  agentIndex: Map<string, string> | null
): string | null {
  return agentIndex?.get(agentId) ?? null;
}

/**
 * Resolve a benchmark agent (root OR sub-agent) across stored runs.
 * Roots and children resolve from one compact map, so an unknown in-flight UUID
 * is O(1) after the map is loaded and never reads the run catalog or scans full
 * bundles on the request path (Pass 2 used to).
 */
export async function findAgentAcrossRuns(agentId: string): Promise<HubAgentView | null> {
  if (!agentId) return null;
  const cachedRunId = agentRunCache.get(agentId);
  if (cachedRunId !== undefined) {
    const view = await getRunAgent(cachedRunId, agentId);
    if (view !== null) return view;
    agentRunCache.delete(agentId);
  }
  if (childIdToRun === null || (!childIdIndexComplete && !childIdToRun.has(agentId))) {
    const load = await startCompactIndexLoad();
    if (load.kind === 'legacy') scheduleLegacyBackfill(load.seed, load.revision);
    if (load.kind !== 'ready' && !childIdToRun?.has(agentId)) {
      throw new BenchmarkHubUnavailableError(
        load.kind === 'legacy'
          ? 'Benchmark Hub archive index is warming; retry shortly'
          : 'Benchmark Hub archive index is temporarily unavailable; retry shortly'
      );
    }
  } else {
    scheduleCompactIndexRefresh();
  }
  if (agentRunMissCache.has(agentId)) return null;
  if (childIdToRun === null) return null;
  const runId = resolveHubRunIdFromAgentIndex(agentId, childIdToRun);
  if (runId !== null) {
    const view = await getRunAgent(runId, agentId);
    if (view !== null) {
      rememberHubRun(agentId, runId);
      return view;
    }
    forgetHubRunFromResolutionCaches(runId, [agentId]);
  }
  agentRunMissCache.add(agentId);
  return null;
}

/** Walk parent_agent_id from a hub tree node up to the root (root first). */
export function ancestorsFromHubTree(
  agentId: string,
  tree: Array<Record<string, unknown>>
): Array<{ id: string; goal: string }> {
  const byId = new Map<string, Record<string, unknown>>();
  for (const node of tree) {
    const id = typeof node.agent_id === 'string' ? node.agent_id : '';
    if (id.length > 0) byId.set(id, node);
  }
  const chain: Array<{ id: string; goal: string }> = [];
  const seen = new Set<string>();
  let current = byId.get(agentId);
  while (current) {
    const parentId = current.parent_agent_id;
    if (typeof parentId !== 'string' || parentId.length === 0 || seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    const goal = typeof parent.goal === 'string' && parent.goal.length > 0 ? parent.goal : 'parent';
    chain.push({ id: parentId, goal });
    current = parent;
  }
  return chain.reverse();
}

export async function findAncestorsAcrossRuns(
  agentId: string
): Promise<Array<{ id: string; goal: string }>> {
  const view = await findAgentAcrossRuns(agentId);
  if (view === null) return [];
  return ancestorsFromHubTree(agentId, view.tree);
}

/**
 * The fan-out tree for a benchmark root, shaped like the normal
 * GET /api/agents/tree response so the main panel renders it unchanged.
 */
export async function findTreeAcrossRuns(
  busId: string
): Promise<Array<Record<string, unknown>> | null> {
  const view = await findAgentAcrossRuns(busId);
  if (view === null) return null;
  const mapped = view.tree.map((node) => ({
    ...node,
    tokens_in: Number(node.tokens_in ?? 0),
    tokens_out: Number(node.tokens_out ?? 0),
    output_schema: node.output_schema ?? null,
    structured_output: node.structured_output ?? null,
    failure_context: undefined,
    created_at: null,
    updated_at: null,
  }));
  return subtreeAgentsForBus(mapped, busId);
}
