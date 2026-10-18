/** Pure compact agent-to-run index state and validation helpers. */

export interface HubAgentRunIndexDocument {
  version: 1;
  revision: number;
  complete: boolean;
  /** Revision of the last locked salvage; a backfill read before it is stale. */
  repaired_revision?: number;
  agents: Record<string, string>;
}

export interface HubAgentRunIndexRevisionDocument {
  version: 1;
  revision: number;
}

export interface HubAgentRunIndexSnapshot {
  cacheVersion?: string;
  revision: number;
  complete: boolean;
  repairedRevision?: number;
  agents: Map<string, string>;
}

/** Catalog fields a bundle-free repair may trust: run identity, upload order, root agents. */
export interface HubAgentIndexCatalogRun {
  run_id: string;
  uploaded_at?: string;
  tasks: Array<{ agent_id?: string | null }>;
}

function repairedRevisionOf(
  snapshot: HubAgentRunIndexSnapshot | null
): Pick<HubAgentRunIndexSnapshot, 'repairedRevision'> {
  return snapshot?.repairedRevision === undefined
    ? {}
    : { repairedRevision: snapshot.repairedRevision };
}

export function hubAgentIndexAfterPut(
  current: HubAgentRunIndexSnapshot | null,
  indexWasEmpty: boolean,
  runId: string,
  agentIds: string[]
): HubAgentRunIndexSnapshot {
  const agents = new Map(current?.agents ?? []);
  for (const [agentId, indexedRunId] of agents) {
    if (indexedRunId === runId) agents.delete(agentId);
  }
  for (const agentId of agentIds) {
    if (agentId) agents.set(agentId, runId);
  }
  return {
    revision: (current?.revision ?? 0) + 1,
    complete: current?.complete ?? indexWasEmpty,
    ...repairedRevisionOf(current),
    agents,
  };
}

export function hubAgentIndexAfterDelete(
  current: HubAgentRunIndexSnapshot,
  runId: string
): HubAgentRunIndexSnapshot {
  const agents = new Map(current.agents);
  for (const [agentId, indexedRunId] of agents) {
    if (indexedRunId === runId) agents.delete(agentId);
  }
  return {
    revision: current.revision + 1,
    complete: current.complete,
    ...repairedRevisionOf(current),
    agents,
  };
}

/**
 * Merge a legacy scan into the current locked index. The newest catalog upload
 * wins for an agent id, as for locked puts, so a concurrent upload beats the
 * scan and the scan beats a stale salvaged mapping; deleted runs stay absent.
 * A scan that started before the latest locked salvage may have missed the
 * mappings that salvage lost, so it merges what it found but cannot declare
 * completion.
 */
export function completedHubAgentBackfill(
  current: HubAgentRunIndexSnapshot | null,
  backfilled: Map<string, string>,
  catalog: Array<{ run_id: string; uploaded_at?: string }>,
  scanStartRevision?: number
): HubAgentRunIndexSnapshot {
  const uploadedAt = new Map(catalog.map((run) => [run.run_id, run.uploaded_at ?? '']));
  const agents = new Map<string, string>();
  for (const [agentId, runId] of current?.agents ?? []) {
    if (uploadedAt.has(runId)) agents.set(agentId, runId);
  }
  for (const [agentId, runId] of backfilled) {
    const scanned = uploadedAt.get(runId);
    if (scanned === undefined) continue;
    const kept = agents.get(agentId);
    if (kept === undefined || scanned > (uploadedAt.get(kept) ?? '')) agents.set(agentId, runId);
  }
  const repairedRevision = current?.repairedRevision;
  return {
    revision: (current?.revision ?? 0) + 1,
    complete:
      repairedRevision === undefined ||
      (scanStartRevision !== undefined && repairedRevision < scanStartRevision),
    ...repairedRevisionOf(current),
    agents,
  };
}

export function parseHubAgentRunIndex(raw: string | null): HubAgentRunIndexSnapshot | null {
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as Partial<HubAgentRunIndexDocument>;
  if (
    parsed.version !== 1 ||
    !Number.isSafeInteger(parsed.revision) ||
    (parsed.revision as number) < 0 ||
    typeof parsed.complete !== 'boolean' ||
    typeof parsed.agents !== 'object' ||
    parsed.agents === null ||
    Array.isArray(parsed.agents) ||
    Object.getPrototypeOf(parsed.agents) !== Object.prototype
  ) {
    throw new Error('Invalid Benchmark Hub agent-run index');
  }
  if (
    parsed.repaired_revision !== undefined &&
    (!Number.isSafeInteger(parsed.repaired_revision) || parsed.repaired_revision < 0)
  ) {
    throw new Error('Invalid Benchmark Hub agent-run index');
  }
  const agents = new Map<string, string>();
  for (const [agentId, runId] of Object.entries(parsed.agents)) {
    if (!agentId || typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId)) {
      throw new Error('Invalid Benchmark Hub agent-run index entry');
    }
    agents.set(agentId, runId);
  }
  return {
    ...(typeof (parsed as { _hub_cache_version?: unknown })._hub_cache_version === 'string'
      ? { cacheVersion: (parsed as { _hub_cache_version: string })._hub_cache_version }
      : {}),
    revision: parsed.revision as number,
    complete: parsed.complete,
    ...(parsed.repaired_revision === undefined
      ? {}
      : { repairedRevision: parsed.repaired_revision }),
    agents,
  };
}

export function parseHubAgentRunIndexRevision(raw: string | null): number {
  if (raw === null) return 0;
  const parsed = JSON.parse(raw) as Partial<HubAgentRunIndexRevisionDocument>;
  if (
    parsed.version !== 1 ||
    !Number.isSafeInteger(parsed.revision) ||
    (parsed.revision as number) < 0
  ) {
    throw new Error('Invalid Benchmark Hub agent-run revision floor');
  }
  return parsed.revision as number;
}

/** Salvage a revision from an otherwise malformed index without trusting its mappings. */
export function recoverableHubAgentRunRevision(raw: string | null): number {
  if (raw === null) return 0;
  try {
    const parsed = JSON.parse(raw) as { revision?: unknown };
    return Number.isSafeInteger(parsed?.revision) && (parsed.revision as number) >= 0
      ? (parsed.revision as number)
      : 0;
  } catch {
    return 0;
  }
}

/**
 * Repair an inconsistent index without reading run bundles. Root agents are
 * re-derived from the catalog (newest upload wins, as for locked puts); child
 * mappings that still point at catalog runs are kept. Whatever else a failed
 * write lost is unknown, so the cooperative out-of-lock backfill restores it.
 */
export function salvagedHubAgentRunIndex(
  persisted: HubAgentRunIndexSnapshot | null,
  catalog: HubAgentIndexCatalogRun[],
  durableRevisionFloor: number
): HubAgentRunIndexSnapshot {
  const validRunIds = new Set(catalog.map((run) => run.run_id));
  const agents = new Map<string, string>();
  for (const [agentId, runId] of persisted?.agents ?? []) {
    if (validRunIds.has(runId)) agents.set(agentId, runId);
  }
  const newestRoot = new Map<string, HubAgentIndexCatalogRun>();
  for (const run of catalog) {
    for (const task of run.tasks) {
      if (!task.agent_id) continue;
      const known = newestRoot.get(task.agent_id);
      if (known === undefined || (run.uploaded_at ?? '') > (known.uploaded_at ?? '')) {
        newestRoot.set(task.agent_id, run);
      }
    }
  }
  for (const [agentId, run] of newestRoot) agents.set(agentId, run.run_id);
  return {
    revision: durableRevisionFloor,
    complete: false,
    repairedRevision: durableRevisionFloor,
    agents,
  };
}
