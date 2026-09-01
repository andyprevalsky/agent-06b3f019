/**
 * Benchmark Hub run storage — uploaded benchmark run bundles + a run index.
 *
 * Layout (R2, reusing the trace-archive bucket + credentials under a
 * `benchmark-hub/` prefix; falls back to a local directory when R2 is not
 * configured, e.g. dev workspaces):
 *
 *   benchmark-hub/index.json          — array of run summaries (newest first)
 *   benchmark-hub/runs/<run_id>.json  — full run bundle (cloudbench-run.json
 *                                       shape: tasks[] with logs.messages and
 *                                       logs.tree from the full-tree copy-down)
 *
 * The same putRun() accepts live snapshots (status: "running", re-upserted as
 * the run progresses) and the final bundle, so the hub UI shows current runs
 * and completed runs through one index.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { ADMIN_USER_IDS } from '../utils/adminAccess';
import {
  deleteHubAncestorSkeletonsFromBundle,
  slotHubAncestorSkeletonsFromBundle,
} from './benchmarkHubAncestors';
import {
  agentIdsFromHubBundle,
  applyHubRunToResolutionCaches,
  forgetHubRunFromResolutionCaches,
  __resetHubResolutionCachesForTest,
} from './benchmarkHubLookup';
import { prisma } from './database';
import { createLogger } from './logger';

export {
  agentIdsFromHubBundle,
  ancestorsFromHubTree,
  applyHubRunToResolutionCaches,
  findAgentAcrossRuns,
  findAncestorsAcrossRuns,
  findTreeAcrossRuns,
  forgetHubRunFromResolutionCaches,
  peekHubResolutionForTest,
  resolveHubRunIdFromIndexes,
  __resetHubResolutionCachesForTest,
} from './benchmarkHubLookup';
export { canonicalAgentTree, getRunAgent } from './benchmarkHubView';

const log = createLogger('BenchmarkHubStore');

const KEY_PREFIX = 'benchmark-hub';
const LOCAL_DIR = path.join(__dirname, '..', '..', '..', '.context', 'benchmark-hub');

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

export interface HubRunTaskSummary {
  name: string;
  passed: boolean | null;
  status: string;
  agent_id: string | null;
  duration_seconds: number | null;
  cost_cents: number | null;
  world_model_mode: string | null;
  fast_mode: boolean;
  tree_agent_count: number | null;
  failure_reason: string | null;
}

export interface HubRunSummary {
  run_id: string;
  timestamp: string;
  suite: string | null;
  source: string | null;
  live: boolean;
  uploaded_at: string;
  tasks: HubRunTaskSummary[];
}

export interface HubAgentView {
  agent: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  tree: Array<Record<string, unknown>>;
}

let s3Client: S3Client | null = null;

function r2Configured(): boolean {
  // Local workspaces have production R2 credentials available for trace
  // diagnostics, but Benchmark Hub writes must stay worktree-local. Otherwise
  // independent test databases race through one production index and local
  // cleanup can hide real runs. Use Render's deployment identity rather than
  // NODE_ENV: local production-mode builds must remain isolated too.
  const useR2 = process.env.BENCHMARK_HUB_STORAGE !== 'local' && process.env.RENDER === 'true';
  return Boolean(
    useR2 &&
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET_TRACE_ARCHIVE
  );
}

function getS3Client(): S3Client {
  if (s3Client !== null) return s3Client;
  const accountId = process.env.R2_ACCOUNT_ID || '';
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
  return s3Client;
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (body instanceof Buffer) return body;
  const stream = body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function putObject(key: string, data: string): Promise<void> {
  if (r2Configured()) {
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
        Key: `${KEY_PREFIX}/${key}`,
        Body: data,
        ContentType: 'application/json',
      })
    );
    return;
  }
  const target = path.join(LOCAL_DIR, key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, target);
}

async function getObject(key: string): Promise<string | null> {
  if (r2Configured()) {
    try {
      const response = await getS3Client().send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
          Key: `${KEY_PREFIX}/${key}`,
        })
      );
      return (await streamToBuffer(response.Body)).toString('utf-8');
    } catch {
      return null;
    }
  }
  try {
    return fs.readFileSync(path.join(LOCAL_DIR, key), 'utf-8');
  } catch {
    return null;
  }
}

const INDEX_LOCK_KEY = 'benchmark-hub:index';

/**
 * Serialize the shared index read-modify-write across every backend process.
 * The index lives in R2, so an in-memory mutex cannot prevent two Render or
 * local workspace processes from reading the same version and losing one
 * another's update. The transaction-scoped Postgres lock is released even
 * when an R2 operation throws.
 */
async function withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${INDEX_LOCK_KEY}))`;
      return operation();
    },
    { maxWait: 30_000, timeout: 30_000 }
  );
}

function normalizeAgentId(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed || null;
}

function taskSummary(task: Record<string, unknown>): HubRunTaskSummary {
  const passed = typeof task.passed === 'boolean' ? task.passed : null;
  // The verdict wins over the raw agent status (run bundles carry the AGENT
  // status — e.g. ACTIVE at scoring time — which is not the task outcome).
  const status =
    passed !== null
      ? passed
        ? 'passed'
        : 'failed'
      : typeof task.status === 'string' && task.status
        ? task.status
        : 'running';
  return {
    name: String(task.name ?? ''),
    passed,
    status,
    agent_id: normalizeAgentId(task.agent_id),
    duration_seconds: typeof task.duration_seconds === 'number' ? task.duration_seconds : null,
    cost_cents: typeof task.cost_cents === 'number' ? task.cost_cents : null,
    world_model_mode: typeof task.world_model_mode === 'string' ? task.world_model_mode : null,
    fast_mode: task.fast_mode_cache_enabled === true || task.fast_mode === true,
    tree_agent_count: typeof task.tree_agent_count === 'number' ? task.tree_agent_count : null,
    failure_reason: typeof task.failure_reason === 'string' ? task.failure_reason : null,
  };
}

/**
 * Upsert a run bundle (live snapshot or final). Returns the stored summary.
 */
export async function putRun(
  bundle: Record<string, unknown>,
  options: { live?: boolean; source?: string } = {}
): Promise<HubRunSummary> {
  const runId = String(bundle.run_id ?? '');
  // Same allowlist as getRunBundle: the id becomes a filename in the local-dir
  // fallback, so anything outside it (e.g. "../../x") must never reach putObject.
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('bundle.run_id required (safe charset)');
  const tasks = Array.isArray(bundle.tasks) ? (bundle.tasks as Array<Record<string, unknown>>) : [];
  const summary: HubRunSummary = {
    run_id: runId,
    timestamp: String(bundle.timestamp ?? new Date().toISOString()),
    suite: typeof bundle.suite === 'string' ? bundle.suite : null,
    source: options.source ?? (typeof bundle.source === 'string' ? bundle.source : null),
    live: options.live === true,
    uploaded_at: new Date().toISOString(),
    tasks: tasks.map(taskSummary),
  };

  let storedSummary = summary;
  await withIndexLock(async () => {
    const index = await listRuns();
    const existing = index.find((run) => run.run_id === runId);
    // Final is an absorbing state. A snapshot loop already in flight may
    // arrive after completion; it must not regress either the bundle or index
    // back to live/running.
    if (existing !== undefined && !existing.live && summary.live) {
      storedSummary = existing;
      return;
    }
    await putObject(`runs/${runId}.json`, JSON.stringify(bundle));
    const next = [summary, ...index.filter((r) => r.run_id !== runId)];
    next.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    await putObject('index.json', JSON.stringify(next));
  });
  log.info('Stored benchmark run bundle', {
    runId,
    live: storedSummary.live,
    tasks: storedSummary.tasks.length,
  });
  await slotHubAncestorSkeletonsFromBundle(bundle);
  applyHubRunToResolutionCaches(runId, agentIdsFromHubBundle(bundle));
  return storedSummary;
}

export async function listRuns(): Promise<HubRunSummary[]> {
  const raw = await getObject('index.json');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as HubRunSummary[]).map((run) => ({
      ...run,
      tasks: Array.isArray(run.tasks)
        ? run.tasks.map((task) => ({ ...task, agent_id: normalizeAgentId(task.agent_id) }))
        : [],
    }));
  } catch {
    return [];
  }
}

export async function getRunBundle(runId: string): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  const raw = await getObject(`runs/${runId}.json`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

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

/**
 * Remove a run from the index (bundle object is left in place — index removal
 * hides it everywhere; object lifecycle is handled by bucket retention).
 * Returns false when the run id was not present.
 */
export async function deleteRun(runId: string): Promise<boolean> {
  const bundle = await getRunBundle(runId);
  const removed = await withIndexLock(async () => {
    const index = await listRuns();
    const next = index.filter((r) => r.run_id !== runId);
    if (next.length === index.length) return false;
    await putObject('index.json', JSON.stringify(next));
    return true;
  });
  if (removed && bundle) {
    await deleteHubAncestorSkeletonsFromBundle(bundle);
    forgetHubRunFromResolutionCaches(runId, agentIdsFromHubBundle(bundle));
  }
  return removed;
}

/** Test-only: reset in-process state (local dir is controlled by the caller). */
export function _resetForTests(): void {
  s3Client = null;
  __resetHubResolutionCachesForTest();
}
