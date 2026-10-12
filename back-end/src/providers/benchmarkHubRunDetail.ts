import { getRunBundle, listRuns } from './benchmarkHubStore';
import { groupedRunCatalog, HUB_GROUP_PAGE_SIZE } from './benchmarkHubRunProjection';
import type {
  HubRunAttempt,
  HubRunCost,
  HubRunDetail,
  HubRunTaskDetail,
} from './benchmarkHubTypes';

export type { HubRunCost, HubRunDetail, HubRunTaskDetail } from './benchmarkHubTypes';

/**
 * The run view's data: index summary enriched per-task from the stored bundle
 * (tokens, cache hit, call/message counts — the report-card fields the fleet
 * dashboard showed) plus run-level totals. Falls back to summary-only fields
 * when the bundle is gone or live-thin.
 */
export async function getRunDetail(
  runId: string,
  page: { offset?: number; limit?: number } = {}
): Promise<HubRunDetail | null> {
  const index = await listRuns({ grouped: false });
  const summary =
    groupedRunCatalog(index, false).find((r) => r.run_id === runId) ??
    index.find((r) => r.run_id === runId);
  if (!summary) return null;
  const bundle = summary.is_group ? null : await getRunBundle(runId);
  const bundleTasks = new Map<string, Record<string, unknown>>();
  if (bundle && Array.isArray(bundle.tasks)) {
    for (const task of bundle.tasks as Array<Record<string, unknown>>) {
      if (typeof task.name === 'string') bundleTasks.set(task.name, task);
    }
  }
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const tasks: HubRunTaskDetail[] = summary.tasks.map((t) => {
    const raw = bundleTasks.get(t.name) ?? t;
    return {
      ...t,
      tokens_in: num(raw.tokens_in),
      tokens_out: num(raw.tokens_out),
      cache_hit_pct: num(raw.cache_hit_pct),
      llm_call_count: num(raw.llm_call_count),
      message_count: num(raw.message_count),
    };
  });
  const physicalTasks = tasks.flatMap<HubRunAttempt | HubRunTaskDetail>(
    (task) => task.attempt_history ?? [task]
  );
  const totals = {
    passed: tasks.filter((t) => t.passed === true).length,
    failed: tasks.filter((t) => t.passed === false).length,
    running: tasks.filter(
      (t) => t.passed === null && !['INFRA_ERROR', 'error', 'cancelled'].includes(t.status)
    ).length,
    cost_cents: physicalTasks.reduce((s, t) => s + (t.cost_cents ?? 0), 0),
    tokens_in: physicalTasks.reduce((s, t) => s + (t.tokens_in ?? 0), 0),
    tokens_out: physicalTasks.reduce((s, t) => s + (t.tokens_out ?? 0), 0),
    agents: physicalTasks.reduce((s, t) => s + (t.tree_agent_count ?? 0), 0),
  };
  const rawCost = (bundle?.cost ?? summary.cost ?? null) as Record<string, unknown> | null;
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
  const offset = Number.isInteger(page.offset) && page.offset! >= 0 ? page.offset! : 0;
  const limit =
    Number.isInteger(page.limit) && page.limit! > 0
      ? Math.min(page.limit!, HUB_GROUP_PAGE_SIZE)
      : HUB_GROUP_PAGE_SIZE;
  return {
    ...summary,
    tasks: summary.is_group ? tasks.slice(offset, offset + limit) : tasks,
    ...(summary.is_group ? { pagination: { offset, limit, total: tasks.length } } : {}),
    totals,
    code:
      typeof bundle?.code === 'string' && bundle.code !== '' ? bundle.code : (summary.code ?? null),
    elapsed_s: num(bundle?.elapsed_s ?? summary.elapsed_s),
    cost,
  };
}
