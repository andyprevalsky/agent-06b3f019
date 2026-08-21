/**
 * Benchmark Hub catalog seeding: tasks.json → BenchmarkTask rows (insert-only,
 * DB wins after seeding) plus the narrow reconcile pass and the memoized
 * ensure-seeded promise catalog routes await at request time.
 */

import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import { getCachedTasks, setCachedTasks } from './catalogCache';

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
 * Seed the BenchmarkTask table from tasks.json: INSERT missing names only.
 * The DB is the source of truth after seeding — file entries never overwrite
 * rows, so hub edits survive redeploys while new catalog entries added via
 * git still show up.
 */
export async function seedBenchmarkTasks(): Promise<{ inserted: number; total: number }> {
  const tasks = (getCachedTasks() ?? []) as RawTask[];
  if (tasks.length === 0) return { inserted: 0, total: 0 };
  const known = new Set(await repo.findExistingTaskNames());
  let inserted = 0;
  for (const task of tasks) {
    if (typeof task.name !== 'string' || known.has(task.name)) continue;
    await repo.createTask({ name: task.name, ...taskColumns(task) });
    inserted += 1;
  }
  await reconcileSeededRows(tasks);
  log.info('Benchmark task seed complete', { inserted, total: known.size + inserted });
  // Public catalog routes serve DB truth once seeded (edits included).
  await refreshTasksFromDb();
  return { inserted, total: known.size + inserted };
}

let seedPromise: Promise<{ inserted: number; total: number }> | null = null;

/**
 * Memoized seed: boot kicks it off and catalog routes await it, so a request
 * arriving before seeding completes waits instead of serving a partial
 * catalog. A failed seed clears the memo (next call retries) — callers
 * swallow the rejection and fall back to the file-backed cache.
 */
export function ensureBenchmarkTasksSeeded(): Promise<{ inserted: number; total: number }> {
  seedPromise ??= seedBenchmarkTasks().catch((err: unknown) => {
    seedPromise = null;
    throw err;
  });
  return seedPromise;
}

/**
 * Narrow exceptions to DB-wins, applied on every seed:
 *   - empty-string descriptions violate the catalog contract (patchTask deletes
 *     the key on clear) — heal rows seeded before that rule existed
 *   - `retired` in tasks.json propagates to existing rows: retirement is a
 *     repo-level decree (the eval suite reads the file). Un-retiring via the
 *     hub still sticks — the poller exports the DB catalog back to tasks.json,
 *     after which the file no longer says retired.
 *   - the `group` label (the Benchmarks page's group filter) is a repo-level
 *     classification, not hub-editable (absent from taskEditSchema), so it
 *     propagates file→DB on every seed — this is how the label reaches rows
 *     seeded before the field existed without a full reseed.
 *   - `environment` is likewise not hub-editable. Catalog contract fields
 *     (secrets, live_targets, services, …) must follow tasks.json or
 *     GET /api/benchmarks keeps serving a stale seeded shape forever.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

async function reconcileSeededRows(tasks: RawTask[]): Promise<void> {
  const retiredInFile = new Set(
    tasks.filter((t) => t.status === 'retired').map((t) => t.name as string)
  );
  const groupInFile = new Map(
    tasks
      .filter((t) => typeof t.group === 'string')
      .map((t) => [t.name as string, t.group as string])
  );
  const environmentInFile = new Map(
    tasks
      .filter((t) => t.environment !== undefined && t.environment !== null)
      .map((t) => [t.name as string, t.environment])
  );
  for (const row of await repo.findAllTasks()) {
    const definition = { ...((row.definition ?? {}) as Record<string, unknown>) };
    const data: repo.BenchmarkTaskUpdate = {};
    if (definition.description === '') {
      delete definition.description;
      data.definition = definition as repo.JsonInput;
    }
    if (retiredInFile.has(row.name) && row.status !== 'retired') {
      data.status = 'retired';
      definition.status = 'retired';
      data.definition = definition as repo.JsonInput;
    }
    const fileGroup = groupInFile.get(row.name);
    if (fileGroup !== undefined && definition.group !== fileGroup) {
      definition.group = fileGroup;
      data.definition = definition as repo.JsonInput;
    }
    const fileEnvironment = environmentInFile.get(row.name);
    if (
      fileEnvironment !== undefined &&
      (stableJson(definition.environment) !== stableJson(fileEnvironment) ||
        stableJson(row.environment) !== stableJson(fileEnvironment))
    ) {
      definition.environment = fileEnvironment;
      data.environment = fileEnvironment as repo.JsonInput;
      data.definition = definition as repo.JsonInput;
    }
    if (Object.keys(data).length > 0) {
      data.updatedBy = 'catalog-seed';
      await repo.updateTask(row.name, data);
      log.info('Reconciled seeded task row', { name: row.name, fields: Object.keys(data) });
    }
  }
}

/** Replace the in-memory public catalog cache with DB definitions. */
export async function refreshTasksFromDb(): Promise<void> {
  const rows = await repo.findAllTasks();
  if (rows.length > 0) {
    setCachedTasks(rows.map((r) => r.definition as Record<string, unknown>));
  }
}
