/**
 * Benchmark Hub catalog seeding: tasks.json → BenchmarkTask rows (file wins)
 * plus the memoized ensure-seeded promise catalog routes await at request time.
 */

import { readCatalogTasks } from './catalog';
import { createLogger } from '../../providers/logger';
import * as repo from './repo';

const log = createLogger('BenchmarkHub');

export interface RawTask extends Record<string, unknown> {
  name: string;
  prompt: string;
}

function taskColumns(task: RawTask) {
  const env = task.environment as Record<string, unknown> | undefined;
  return {
    title: typeof task.title === 'string' ? task.title : null,
    prompt: task.prompt,
    status: typeof task.status === 'string' ? task.status : null,
    bench: typeof task.bench === 'string' ? task.bench : null,
    runner: typeof task.runner === 'string' ? task.runner : null,
    tags: Array.isArray(task.tags)
      ? (task.tags as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    timeoutSeconds: typeof task.timeout_seconds === 'number' ? task.timeout_seconds : null,
    priceLimitCents: typeof task.price_limit_cents === 'number' ? task.price_limit_cents : null,
    expectedTools: Array.isArray(task.expected_tools)
      ? (task.expected_tools as unknown[]).filter((t): t is string => typeof t === 'string')
      : [],
    minAgentCount: typeof task.min_agent_count === 'number' ? task.min_agent_count : null,
    isChatMode: task.is_chat_mode === true,
    environment: (env ?? undefined) as repo.JsonInput | undefined,
    evaluators: (task.evaluators ?? undefined) as repo.JsonInput | undefined,
    source: (task.source ?? undefined) as repo.JsonInput | undefined,
    definition: task as repo.JsonInput,
  };
}

/**
 * Sync the BenchmarkTask table from tasks.json: insert missing names and
 * overwrite existing rows so the DB mirrors git. Public routes read tasks.json
 * directly on each request.
 */
export async function seedBenchmarkTasks(): Promise<{
  inserted: number;
  updated: number;
  total: number;
}> {
  const tasks = readCatalogTasks() as RawTask[];
  if (tasks.length === 0) return { inserted: 0, updated: 0, total: 0 };
  const known = new Set(await repo.findExistingTaskNames());
  let inserted = 0;
  let updated = 0;
  for (const task of tasks) {
    if (typeof task.name !== 'string') continue;
    const columns = taskColumns(task);
    if (known.has(task.name)) {
      await repo.updateTask(task.name, { ...columns, updatedBy: 'catalog-seed' });
      updated += 1;
    } else if (await repo.insertTaskIfAbsent({ name: task.name, ...columns })) {
      inserted += 1;
    } else {
      // Another instance inserted it while this one seeded; still mirror git.
      await repo.updateTask(task.name, { ...columns, updatedBy: 'catalog-seed' });
      updated += 1;
    }
  }
  log.info('Benchmark task seed complete', { inserted, updated, total: tasks.length });
  return { inserted, updated, total: tasks.length };
}

let seedPromise: Promise<{ inserted: number; updated: number; total: number }> | null = null;

/**
 * Memoized seed: boot kicks it off and catalog routes await it, so a request
 * arriving before seeding completes waits instead of serving a partial catalog.
 * A failed seed clears the memo (next call retries).
 */
export function ensureBenchmarkTasksSeeded(): Promise<{
  inserted: number;
  updated: number;
  total: number;
}> {
  seedPromise ??= seedBenchmarkTasks().catch((err: unknown) => {
    seedPromise = null;
    throw err;
  });
  return seedPromise;
}
