/** Pure compact agent-to-run index state and validation helpers. */

export interface HubAgentRunIndexDocument {
  version: 1;
  revision: number;
  complete: boolean;
  agents: Record<string, string>;
}

export interface HubAgentRunIndexRevisionDocument {
  version: 1;
  revision: number;
}

export interface HubAgentRunIndexSnapshot {
  revision: number;
  complete: boolean;
  agents: Map<string, string>;
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
    agents,
  };
}

/** Current locked uploads win over a legacy scan; deleted runs stay absent. */
export function completedHubAgentBackfill(
  current: HubAgentRunIndexSnapshot | null,
  backfilled: Map<string, string>,
  validRunIds: Set<string>
): HubAgentRunIndexSnapshot {
  const agents = new Map<string, string>();
  for (const [agentId, runId] of current?.agents ?? []) {
    if (validRunIds.has(runId)) agents.set(agentId, runId);
  }
  for (const [agentId, runId] of backfilled) {
    if (validRunIds.has(runId) && !agents.has(agentId)) agents.set(agentId, runId);
  }
  return {
    revision: (current?.revision ?? 0) + 1,
    complete: true,
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
  const agents = new Map<string, string>();
  for (const [agentId, runId] of Object.entries(parsed.agents)) {
    if (!agentId || typeof runId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(runId)) {
      throw new Error('Invalid Benchmark Hub agent-run index entry');
    }
    agents.set(agentId, runId);
  }
  return {
    revision: parsed.revision as number,
    complete: parsed.complete,
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

/** Rebuild every mapping; any unreadable run aborts before complete can be published. */
export async function rebuildHubAgentRunIndexWithExtractor(
  index: Array<{ run_id: string }>,
  loadBundle: (runId: string) => Promise<Record<string, unknown>>,
  durableRevisionFloor: number,
  extractAgentIds: (bundle: Record<string, unknown>) => string[]
): Promise<HubAgentRunIndexSnapshot> {
  const agents = new Map<string, string>();
  for (const run of index) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const bundle = await loadBundle(run.run_id);
    for (const agentId of extractAgentIds(bundle)) {
      if (!agents.has(agentId)) agents.set(agentId, run.run_id);
    }
  }
  return { revision: durableRevisionFloor, complete: true, agents };
}
