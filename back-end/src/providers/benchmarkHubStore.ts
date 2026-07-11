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
import { createLogger } from './logger';

const log = createLogger('BenchmarkHubStore');

const KEY_PREFIX = 'benchmark-hub';
const LOCAL_DIR = path.join(__dirname, '..', '..', '..', '.context', 'benchmark-hub');

/**
 * Benchmark Hub access allowlist: hub reads/edits/dispatch and the benchmark-
 * agent fallback on the normal agent APIs are internal-team tooling. Mirrors
 * the front-end ADMIN_USER_IDS (terminal-component-group/config.ts).
 */
export const BENCHMARK_HUB_ADMIN_USER_IDS = new Set([
  '1f85ff25-6e29-4c1b-8739-f917bd101a30', // Andy Prevalsky
  '43c2f6ae-37c0-42d0-bd88-2d6fc335b9e9', // Tamara Chayo
]);

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
  return Boolean(
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

// Serialize index read-modify-write within this process. Uploads come from
// one poller at a time in practice; this guards concurrent snapshot posts.
let indexLock: Promise<void> = Promise.resolve();

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
    agent_id: typeof task.agent_id === 'string' ? task.agent_id : null,
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

  await putObject(`runs/${runId}.json`, JSON.stringify(bundle));

  const release = indexLock;
  let done: () => void = () => {};
  indexLock = new Promise((resolve) => {
    done = resolve;
  });
  try {
    await release;
    const index = await listRuns();
    const next = [summary, ...index.filter((r) => r.run_id !== runId)];
    next.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    await putObject('index.json', JSON.stringify(next));
  } finally {
    done();
  }
  log.info('Stored benchmark run bundle', { runId, live: summary.live, tasks: tasks.length });
  return summary;
}

export async function listRuns(): Promise<HubRunSummary[]> {
  const raw = await getObject('index.json');
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HubRunSummary[]) : [];
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

function frontendMessage(
  agentId: string,
  index: number,
  raw: Record<string, unknown>
): Record<string, unknown> {
  return {
    message_id: raw.message_id ?? `${agentId}-hub-message-${String(index).padStart(4, '0')}`,
    timestamp: raw.created_at ?? raw.timestamp ?? '',
    text: raw.message ?? raw.text ?? '',
    role: String(raw.role ?? 'ASSISTANT').toUpperCase(),
    metadata: raw.metadata ?? {},
    file_pointer: raw.file_pointer ?? null,
  };
}

function agentSummaryFromTask(
  task: Record<string, unknown>,
  agentId: string,
  messages: Array<Record<string, unknown>>,
  runTimestamp: string,
  parent: { parentAgentId: string | null; busId: string; goal: string; status: string }
): Record<string, unknown> {
  return {
    agent_id: agentId,
    parent_agent_id: parent.parentAgentId,
    parent_goal: null,
    busId: parent.busId,
    goal: parent.goal,
    model: 'benchmark-hub',
    source: parent.parentAgentId === null ? 'WEB' : 'AGENT',
    reasoning_effort: 'off',
    reasoning_max_tokens: null,
    progress: parent.status === 'COMPLETED' ? 100 : 0,
    status: parent.status,
    status_message: `Benchmark hub archive: ${String(task.name ?? '')}`,
    temporal_workflow_id: `benchmark-hub-${agentId}`,
    token_count: Number(task.tokens_in ?? 0) + Number(task.tokens_out ?? 0),
    tokens_in: Number(task.tokens_in ?? 0),
    tokens_out: Number(task.tokens_out ?? 0),
    tool_tokens_in: 0,
    tool_tokens_out: 0,
    tool_cost_cents: 0,
    context_size: 0,
    message_count: messages.length,
    price_limit_cents: 0,
    tree_cost_cents: Number(task.cost_cents ?? 0),
    fast_mode_cache_enabled: task.fast_mode_cache_enabled === true,
    token_in_price_microdollars: null,
    token_out_price_microdollars: null,
    created_at: runTimestamp,
    updated_at:
      messages.length > 0
        ? (messages[messages.length - 1].timestamp ?? runTimestamp)
        : runTimestamp,
    write_lock_enabled: true,
    structured_output: null,
    failure_context: null,
    verifier: null,
    tools: [],
    tools_in_use: [],
    response_schema: null,
    benchmark_task: task.name ?? null,
    benchmark_duration_seconds: Number(task.duration_seconds ?? 0),
    benchmark_world_model_mode: task.world_model_mode ?? null,
  };
}

/**
 * Adapt a run bundle to the frontend agent-detail shape for one agent in the
 * run (root or any sub-agent captured by logs.tree), plus the fan-out tree.
 */
export async function getRunAgent(runId: string, agentId: string): Promise<HubAgentView | null> {
  const bundle = await getRunBundle(runId);
  if (!bundle) return null;
  const runTimestamp = String(bundle.timestamp ?? '');
  const tasks = Array.isArray(bundle.tasks) ? (bundle.tasks as Array<Record<string, unknown>>) : [];

  for (const task of tasks) {
    const rootId = typeof task.agent_id === 'string' ? task.agent_id : '';
    if (!rootId) continue;
    const logs = (task.logs ?? {}) as Record<string, unknown>;
    const tree = (logs.tree ?? {}) as Record<string, Record<string, unknown>>;
    const isRoot = agentId === rootId;
    const inTree = Object.prototype.hasOwnProperty.call(tree, agentId);
    if (!isRoot && !inTree) continue;

    const rootMessages = Array.isArray(logs.messages)
      ? (logs.messages as Array<Record<string, unknown>>)
      : [];
    const passedStatus = task.passed === true ? 'COMPLETED' : 'FAILED';

    const nodeInfo = (
      id: string
    ): {
      parent: string | null;
      goal: string;
      status: string;
      raw: Array<Record<string, unknown>>;
    } => {
      const info = tree[id] ?? {};
      const treeMessages = Array.isArray(info.messages)
        ? (info.messages as Array<Record<string, unknown>>)
        : [];
      const isRootNode = id === rootId;
      return {
        parent: isRootNode ? null : ((info.parent_agent_id as string | null) ?? rootId),
        goal:
          typeof info.goal === 'string' && info.goal
            ? info.goal
            : isRootNode
              ? String(
                  rootMessages.find((m) => String(m.role ?? '').toUpperCase() === 'USER')
                    ?.message ??
                    task.name ??
                    'benchmark task'
                )
              : 'sub-agent',
        status: String(info.status ?? (isRootNode ? passedStatus : 'COMPLETED')).toUpperCase(),
        raw: isRootNode && treeMessages.length === 0 ? rootMessages : treeMessages,
      };
    };

    const target = nodeInfo(agentId);
    const messages = target.raw.map((m, i) => frontendMessage(agentId, i, m));
    const agent = agentSummaryFromTask(task, agentId, messages, runTimestamp, {
      parentAgentId: target.parent,
      busId: rootId,
      goal: target.goal,
      status: target.status,
    });

    const treeIds = new Set<string>([rootId, ...Object.keys(tree)]);
    const treeNodes = [...treeIds].map((id) => {
      const info = nodeInfo(id);
      return {
        agent_id: id,
        parent_agent_id: info.parent,
        goal: info.goal,
        status: info.status,
        progress: info.status === 'COMPLETED' ? 100 : 0,
        tools_in_use: [],
        message_count: info.raw.length,
        tree_cost_cents: id === rootId ? Number(task.cost_cents ?? 0) : 0,
      };
    });

    return { agent, messages, tree: treeNodes };
  }
  return null;
}

/**
 * Remove a run from the index (bundle object is left in place — index removal
 * hides it everywhere; object lifecycle is handled by bucket retention).
 * Returns false when the run id was not present.
 */
export async function deleteRun(runId: string): Promise<boolean> {
  const release = indexLock;
  let done: () => void = () => {};
  indexLock = new Promise((resolve) => {
    done = resolve;
  });
  try {
    await release;
    const index = await listRuns();
    const next = index.filter((r) => r.run_id !== runId);
    if (next.length === index.length) return false;
    await putObject('index.json', JSON.stringify(next));
    return true;
  } finally {
    done();
  }
}

// agentId → run_id resolution cache (bundles are immutable once final; a live
// re-upload keeps the same run_id, so cached mappings never go stale).
const agentRunCache = new Map<string, string>();

/**
 * Resolve a benchmark agent (root OR sub-agent) across every stored run —
 * newest first — and return its adapted view. Roots resolve from the index
 * alone; sub-agents require scanning bundles (cached thereafter). This powers
 * the normal agent-API fallback so benchmark agents open in the main panel.
 */
export async function findAgentAcrossRuns(agentId: string): Promise<HubAgentView | null> {
  if (!agentId) return null;
  const cachedRunId = agentRunCache.get(agentId);
  if (cachedRunId !== undefined) {
    const view = await getRunAgent(cachedRunId, agentId);
    if (view !== null) return view;
    agentRunCache.delete(agentId);
  }
  const index = await listRuns();
  // Pass 1: roots straight from the index (no bundle reads).
  for (const run of index) {
    if (run.tasks.some((t) => t.agent_id === agentId)) {
      const view = await getRunAgent(run.run_id, agentId);
      if (view !== null) {
        agentRunCache.set(agentId, run.run_id);
        return view;
      }
    }
  }
  // Pass 2: sub-agents — scan bundles (bounded by index size).
  for (const run of index) {
    const view = await getRunAgent(run.run_id, agentId);
    if (view !== null) {
      agentRunCache.set(agentId, run.run_id);
      return view;
    }
  }
  return null;
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
    tokens_in: 0,
    tokens_out: 0,
    output_schema: null,
    structured_output: null,
    failure_context: undefined,
    created_at: null,
    updated_at: null,
  }));
}

/** Test-only: reset in-process state (local dir is controlled by the caller). */
export function _resetForTests(): void {
  s3Client = null;
  indexLock = Promise.resolve();
  agentRunCache.clear();
}
