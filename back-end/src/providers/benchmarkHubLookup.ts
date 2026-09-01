/**
 * O(1) hub agent-id resolution for GET /agents/:id.
 *
 * Official 4w creates a client UUID and reads the row before POST commits.
 * A per-request scan of every hub bundle on that miss starves Prisma.
 * Unknown IDs miss without reading bundles; uploads/deletes keep the maps
 * aligned with the live index so a later GET cannot serve a deleted run.
 */
import { getRunBundle, listRuns, type HubAgentView, type HubRunSummary } from './benchmarkHubStore';
import { canonicalAgentTree, getRunAgent } from './benchmarkHubView';

const agentRunCache = new Map<string, string>();
const agentRunMissCache = new Set<string>();
let childIdToRun: Map<string, string> | null = null;
let childIdIndexPromise: Promise<Map<string, string>> | null = null;

async function buildChildIdIndex(): Promise<Map<string, string>> {
  const index = await listRuns();
  const map = new Map<string, string>();
  for (const run of index) {
    const bundle = await getRunBundle(run.run_id);
    if (bundle === null) continue;
    for (const id of agentIdsFromHubBundle(bundle)) {
      if (!map.has(id)) map.set(id, run.run_id);
    }
  }
  childIdToRun = map;
  return map;
}

function scheduleChildIdIndex(): void {
  if (childIdIndexPromise !== null || childIdToRun !== null) return;
  childIdIndexPromise = buildChildIdIndex().catch((error: unknown) => {
    childIdIndexPromise = null;
    throw error;
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
export function applyHubRunToResolutionCaches(runId: string, agentIds: string[]): void {
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
  childIdIndexPromise = null;
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

/** Index-only lookup: roots from listRuns, children from the built id map. */
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

/**
 * Resolve a benchmark agent (root OR sub-agent) across stored runs.
 * Roots resolve from the index alone. Child IDs use a once-built map so an
 * unknown in-flight UUID is O(1) after the map exists and never scans every
 * bundle on the request path (Pass 2 used to).
 */
export async function findAgentAcrossRuns(agentId: string): Promise<HubAgentView | null> {
  if (!agentId) return null;
  if (agentRunMissCache.has(agentId)) return null;
  const index = await listRuns();
  const indexedRunIds = new Set(index.map((run) => run.run_id));
  const cachedRunId = agentRunCache.get(agentId);
  if (cachedRunId !== undefined) {
    if (indexedRunIds.has(cachedRunId)) {
      const view = await getRunAgent(cachedRunId, agentId);
      if (view !== null) return view;
    }
    agentRunCache.delete(agentId);
  }
  const resolved = resolveHubRunIdFromIndexes(agentId, index, childIdToRun);
  if (resolved.kind === 'hit') {
    if (!indexedRunIds.has(resolved.runId)) {
      forgetHubRunFromResolutionCaches(resolved.runId, [agentId]);
    } else {
      const view = await getRunAgent(resolved.runId, agentId);
      if (view !== null) {
        rememberHubRun(agentId, resolved.runId);
        return view;
      }
    }
  }
  if (resolved.kind === 'pending') {
    scheduleChildIdIndex();
    return null;
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
  return view.tree.map((node) => ({
    ...node,
    tokens_in: Number(node.tokens_in ?? 0),
    tokens_out: Number(node.tokens_out ?? 0),
    output_schema: node.output_schema ?? null,
    structured_output: node.structured_output ?? null,
    failure_context: undefined,
    created_at: null,
    updated_at: null,
  }));
}
