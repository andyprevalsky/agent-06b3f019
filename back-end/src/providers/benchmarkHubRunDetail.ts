import {
  getRunBundle,
  listRuns,
  type HubRunSummary,
  type HubRunTaskSummary,
} from './benchmarkHubStore';

export interface HubRunTaskDetail extends HubRunTaskSummary {
  tokens_in: number | null;
  tokens_out: number | null;
  cache_hit_pct: number | null;
  llm_call_count: number | null;
  message_count: number | null;
}

export interface HubRunCost {
  agents_llm_usd: number | null;
  wmh_grounding_usd: number | null;
  infra_usd: number | null;
  total_usd: number | null;
  fast_cache_hit_rate: number | null;
}

export interface HubRunDetail extends Omit<HubRunSummary, 'tasks'> {
  tasks: HubRunTaskDetail[];
  totals: {
    passed: number;
    failed: number;
    running: number;
    cost_cents: number;
    tokens_in: number;
    tokens_out: number;
    agents: number;
  };
  /** Code provenance from the executing controller (branch@ref + dirty diff). */
  code: string | null;
  /** Run wall-clock from the report card (falls back to now - timestamp live). */
  elapsed_s: number | null;
  /** Report-card cost breakdown (LLM / WMH grounding / infra vCPU / total). */
  cost: HubRunCost | null;
}

/**
 * The run view's data: index summary enriched per-task from the stored bundle
 * (tokens, cache hit, call/message counts — the report-card fields the fleet
 * dashboard showed) plus run-level totals. Falls back to summary-only fields
 * when the bundle is gone or live-thin.
 */
export async function getRunDetail(runId: string): Promise<HubRunDetail | null> {
  const index = await listRuns();
  const summary = index.find((r) => r.run_id === runId);
  if (!summary) return null;
  const bundle = await getRunBundle(runId);
  const bundleTasks = new Map<string, Record<string, unknown>>();
  if (bundle && Array.isArray(bundle.tasks)) {
    for (const task of bundle.tasks as Array<Record<string, unknown>>) {
      if (typeof task.name === 'string') bundleTasks.set(task.name, task);
    }
  }
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const tasks: HubRunTaskDetail[] = summary.tasks.map((t) => {
    const raw = bundleTasks.get(t.name) ?? {};
    return {
      ...t,
      tokens_in: num(raw.tokens_in),
      tokens_out: num(raw.tokens_out),
      cache_hit_pct: num(raw.cache_hit_pct),
      llm_call_count: num(raw.llm_call_count),
      message_count: num(raw.message_count),
    };
  });
  const totals = {
    passed: tasks.filter((t) => t.passed === true).length,
    failed: tasks.filter((t) => t.passed === false).length,
    running: tasks.filter((t) => t.passed === null).length,
    cost_cents: tasks.reduce((s, t) => s + (t.cost_cents ?? 0), 0),
    tokens_in: tasks.reduce((s, t) => s + (t.tokens_in ?? 0), 0),
    tokens_out: tasks.reduce((s, t) => s + (t.tokens_out ?? 0), 0),
    agents: tasks.reduce((s, t) => s + (t.tree_agent_count ?? 0), 0),
  };
  const rawCost = (bundle?.cost ?? null) as Record<string, unknown> | null;
  const cost: HubRunCost | null =
    rawCost === null
      ? null
      : {
          agents_llm_usd: num(rawCost.agents_llm_usd),
          wmh_grounding_usd: num(rawCost.wmh_grounding_usd),
          infra_usd: num(rawCost.infra_usd),
          total_usd: num(rawCost.total_usd),
          fast_cache_hit_rate: num(rawCost.fast_cache_hit_rate),
        };
  return {
    ...summary,
    tasks,
    totals,
    code: typeof bundle?.code === 'string' && bundle.code !== '' ? bundle.code : null,
    elapsed_s: num(bundle?.elapsed_s),
    cost,
  };
}
