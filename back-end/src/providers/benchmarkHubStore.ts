/**
 * Benchmark Hub run storage — uploaded benchmark run bundles + a run index.
 *
 * Layout (R2, reusing the trace-archive bucket + credentials under a
 * `benchmark-hub/` prefix; falls back to a local directory when R2 is not
 * configured, e.g. dev workspaces):
 *
 *   benchmark-hub/index.json          — array of run summaries (newest first)
 *   benchmark-hub/agent-run-index.json — compact agent-id → run-id lookup
 *   benchmark-hub/runs/<run_id>.json  — full run bundle (cloudbench-run.json
 *                                       shape: tasks[] with logs.messages and
 *                                       logs.tree from the full-tree copy-down)
 *
 * The same putRun() accepts live snapshots (status: "running", re-upserted as
 * the run progresses) and the final bundle, so the hub UI shows current runs
 * and completed runs through one index.
 */

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import * as fs from 'node:fs/promises';
import path from 'path';
import { ADMIN_USER_IDS } from '../utils/adminAccess';
import {
  deleteHubAncestorSkeletonsFromBundle,
  slotHubAncestorSkeletonsFromBundle,
} from './benchmarkHubAncestors';
import {
  completedHubAgentBackfill,
  hubAgentIndexAfterDelete,
  hubAgentIndexAfterPut,
  parseHubAgentRunIndex,
  parseHubAgentRunIndexRevision,
  rebuildHubAgentRunIndexWithExtractor,
  recoverableHubAgentRunRevision,
  type HubAgentRunIndexDocument,
  type HubAgentRunIndexRevisionDocument,
  type HubAgentRunIndexSnapshot,
} from './benchmarkHubAgentIndex';
import {
  agentIdsFromHubBundle,
  applyHubRunToResolutionCaches,
  forgetHubRunFromResolutionCaches,
  __resetHubResolutionCachesForTest,
} from './benchmarkHubLookup';
import { BenchmarkHubUnavailableError } from './benchmarkHubErrors';
import { coalesceHubRunPuts } from './benchmarkHubInFlight';
import { prisma } from './database';
import { createLogger } from './logger';

export {
  agentIdsFromHubBundle,
  ancestorsFromHubTree,
  applyHubRunToResolutionCaches,
  backfillHubAgentRunIndex,
  backfillHubAgentRunIndexFromCatalog,
  findAgentAcrossRuns,
  findAncestorsAcrossRuns,
  findTreeAcrossRuns,
  forgetHubRunFromResolutionCaches,
  installHubAgentRunIndex,
  legacyBackfillRetryDelayMs,
  loadCompactHubAgentIndex,
  peekHubResolutionForTest,
  resolveHubRunIdFromIndexes,
  resolveHubRunIdFromAgentIndex,
  __resetHubResolutionCachesForTest,
} from './benchmarkHubLookup';
export {
  completedHubAgentBackfill,
  hubAgentIndexAfterDelete,
  hubAgentIndexAfterPut,
  parseHubAgentRunIndex,
  parseHubAgentRunIndexRevision,
  recoverableHubAgentRunRevision,
  type HubAgentRunIndexSnapshot,
} from './benchmarkHubAgentIndex';
export { canonicalAgentTree, getRunAgent, subtreeAgentsForBus } from './benchmarkHubView';

const log = createLogger('BenchmarkHubStore');

const KEY_PREFIX = 'benchmark-hub';
const LOCAL_HUB_ROOT = path.join(__dirname, '..', '..', '..', '.context', 'benchmark-hub');
const isolatedRunId =
  process.env.BENCHMARK_ISOLATED_RUN === 'true' ? process.env.BENCHMARK_RUN_ID : undefined;
if (
  process.env.BENCHMARK_ISOLATED_RUN === 'true' &&
  (isolatedRunId === '.' ||
    isolatedRunId === '..' ||
    !/^[A-Za-z0-9._-]+$/.test(isolatedRunId ?? ''))
) {
  throw new Error('BENCHMARK_RUN_ID must be a safe, nonempty ID for an isolated Benchmark Hub');
}
// Each isolated stack has its own database. Keep its local Hub index in the
// same isolation boundary so parallel stacks cannot overwrite one another's
// run registrations before the terminal bundles are mirrored to the durable Hub.
const LOCAL_DIR = isolatedRunId
  ? path.join(LOCAL_HUB_ROOT, 'isolated-runs', isolatedRunId)
  : LOCAL_HUB_ROOT;
const AGENT_RUN_INDEX_KEY = 'agent-run-index.json';
const AGENT_RUN_INDEX_REVISION_KEY = 'agent-run-index-revision.json';

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
  lifecycle_stage?: string;
  startup_label?: string;
  row_id?: string;
  child_run_id?: string;
  run_number?: number;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cache_hit_pct?: number | null;
  llm_call_count?: number | null;
  message_count?: number | null;
}

export interface HubRunSummary {
  run_id: string;
  timestamp: string;
  suite: string | null;
  source: string | null;
  live: boolean;
  uploaded_at: string;
  tasks: HubRunTaskSummary[];
  group_run_id?: string;
  group_member_id?: string;
  group_run_number?: number;
  group_timestamp?: string;
  group_total?: number;
  run_group?: {
    members: Array<{ member_id: string; name: string; run_number: number }>;
    status: string;
    outcomes: Record<string, { status: string; controller_exit_code: number | null }>;
    wall_clock_seconds: number | null;
    finished_at: string | null;
  };
  is_group?: boolean;
  task_total?: number;
  task_counts?: {
    passed: number;
    failed: number;
    queued: number;
    infra_error?: number;
    cancelled?: number;
  };
  code?: string | null;
  elapsed_s?: number | null;
  cost?: Record<string, unknown> | null;
}

export interface HubAgentView {
  agent: Record<string, unknown>;
  messages: Array<Record<string, unknown>>;
  tree: Array<Record<string, unknown>>;
}

export function hubRunVisibleFromMarker(marker: string | null): boolean {
  return marker === null || marker === 'true';
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
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, target);
}

function isObjectNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as {
    code?: unknown;
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return (
    record.code === 'ENOENT' ||
    record.name === 'NoSuchKey' ||
    record.name === 'NotFound' ||
    record.$metadata?.httpStatusCode === 404
  );
}

/** Null means a confirmed missing object; transport/permission faults throw. */
async function getObjectStrict(key: string): Promise<string | null> {
  if (r2Configured()) {
    try {
      const response = await getS3Client().send(
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_TRACE_ARCHIVE || '',
          Key: `${KEY_PREFIX}/${key}`,
        })
      );
      return (await streamToBuffer(response.Body)).toString('utf-8');
    } catch (error: unknown) {
      if (isObjectNotFound(error)) return null;
      throw error;
    }
  }
  try {
    return await fs.readFile(path.join(LOCAL_DIR, key), 'utf-8');
  } catch (error: unknown) {
    if (isObjectNotFound(error)) return null;
    throw error;
  }
}

async function getObject(key: string): Promise<string | null> {
  try {
    return await getObjectStrict(key);
  } catch {
    return null;
  }
}

async function readAgentRunIndexStrict(): Promise<HubAgentRunIndexSnapshot | null> {
  const [rawIndex, rawRevision] = await Promise.all([
    getObjectStrict(AGENT_RUN_INDEX_KEY),
    getObjectStrict(AGENT_RUN_INDEX_REVISION_KEY),
  ]);
  const index = parseHubAgentRunIndex(rawIndex);
  const durableRevisionFloor = parseHubAgentRunIndexRevision(rawRevision);
  if (index === null) {
    if (durableRevisionFloor === 0) return null;
    throw new Error('Benchmark Hub agent-run index is missing above its revision floor');
  }
  if (index.revision < durableRevisionFloor) {
    throw new Error('Benchmark Hub agent-run index trails its durable revision floor');
  }
  return index;
}

async function writeAgentRunIndex(index: HubAgentRunIndexSnapshot): Promise<void> {
  const revision: HubAgentRunIndexRevisionDocument = {
    version: 1,
    revision: index.revision,
  };
  const document: HubAgentRunIndexDocument = {
    version: 1,
    revision: index.revision,
    complete: index.complete,
    agents: Object.fromEntries(index.agents),
  };
  // Advance the separate floor first. If the following index write fails, the
  // next locked mutation allocates above it rather than publishing a revision
  // that an already-ahead replica would reject.
  await putObject(AGENT_RUN_INDEX_REVISION_KEY, JSON.stringify(revision));
  await putObject(AGENT_RUN_INDEX_KEY, JSON.stringify(document));
}

export async function rebuildHubAgentRunIndex(
  index: HubRunSummary[],
  loadBundle: (runId: string) => Promise<Record<string, unknown>>,
  durableRevisionFloor: number
): Promise<HubAgentRunIndexSnapshot> {
  return rebuildHubAgentRunIndexWithExtractor(
    index,
    loadBundle,
    durableRevisionFloor,
    agentIdsFromHubBundle
  );
}

/** Locked mutations repair malformed/partially-written indexes before changing state. */
async function readAgentRunIndexForMutation(
  authoritativeRuns: HubRunSummary[]
): Promise<HubAgentRunIndexSnapshot | null> {
  const [rawIndex, rawRevision] = await Promise.all([
    getObjectStrict(AGENT_RUN_INDEX_KEY),
    getObjectStrict(AGENT_RUN_INDEX_REVISION_KEY),
  ]);
  let revisionFloorMalformed = false;
  let parsedRevisionFloor: number;
  try {
    parsedRevisionFloor = parseHubAgentRunIndexRevision(rawRevision);
  } catch {
    revisionFloorMalformed = true;
    parsedRevisionFloor = recoverableHubAgentRunRevision(rawRevision);
  }
  const durableRevisionFloor = Math.max(
    parsedRevisionFloor,
    recoverableHubAgentRunRevision(rawIndex)
  );
  try {
    if (revisionFloorMalformed) {
      throw new Error('Benchmark Hub agent-run revision floor is malformed');
    }
    const parsed = parseHubAgentRunIndex(rawIndex);
    if (parsed === null) {
      if (durableRevisionFloor === 0) return null;
      throw new Error('Benchmark Hub agent-run index is missing above its revision floor');
    }
    if (parsed.revision < durableRevisionFloor) {
      throw new Error('Benchmark Hub agent-run index trails its durable revision floor');
    }
    return parsed;
  } catch (error: unknown) {
    log.warn('Rebuilding malformed Benchmark Hub agent-run index during locked mutation', {
      error: error instanceof Error ? error.message : String(error),
      durableRevisionFloor,
      runs: authoritativeRuns.length,
    });
    return rebuildHubAgentRunIndex(authoritativeRuns, getRunBundleStrict, durableRevisionFloor);
  }
}

/** Read one committed compact snapshot, sharing the multi-object writer boundary. */
export async function loadHubAgentRunIndex(): Promise<HubAgentRunIndexSnapshot | null> {
  return withIndexLock(readAgentRunIndexStrict);
}

/** A small exact-key tombstone keeps stale per-process maps from serving deleted runs. */
export async function isHubRunVisible(runId: string): Promise<boolean | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return false;
  try {
    const marker = await getObjectStrict(`visibility/${runId}.json`);
    return hubRunVisibleFromMarker(marker);
  } catch (error: unknown) {
    log.warn('Benchmark Hub visibility read is temporarily unknown', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

const INDEX_LOCK_KEY = 'benchmark-hub:index';
let indexAdmissionTail: Promise<void> = Promise.resolve();

/**
 * Serialize the shared index read-modify-write across every backend process.
 * The index lives in R2, so an in-memory mutex cannot prevent two Render or
 * local workspace processes from reading the same version and losing one
 * another's update. The transaction-scoped Postgres lock is released even
 * when an R2 operation throws.
 */
async function withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
  // Wait before borrowing a connection. Otherwise concurrent uploads occupy
  // the SQL pool while waiting for the same cross-process advisory lock.
  const pending = indexAdmissionTail.then(() =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${INDEX_LOCK_KEY}))`;
        return operation();
      },
      // A corruption-only repair may cooperatively read the entire archive while
      // holding this cross-process lock. Normal writes remain small, but the rare
      // repair must finish atomically rather than timing out at the old 30s limit.
      { maxWait: 30_000, timeout: 5 * 60_000 }
    )
  );
  // A rejected mutation remains rejected for its caller and releases the next
  // admission, just as PostgreSQL releases the transaction-scoped lock.
  indexAdmissionTail = pending.then(() => undefined).catch(() => undefined);
  return pending;
}

function normalizeAgentId(value: unknown): string | null {
  return (typeof value === 'string' ? value.trim() : '') || null;
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
    ...(typeof task.lifecycle_stage === 'string' ? { lifecycle_stage: task.lifecycle_stage } : {}),
    ...(typeof task.startup_label === 'string' ? { startup_label: task.startup_label } : {}),
  };
}

/**
 * Upsert a run bundle (live snapshot or final). Returns the stored summary.
 */
const HUB_GROUP_FIELDS = [
  'group_run_id',
  'group_member_id',
  'group_run_number',
  'group_timestamp',
  'group_total',
] as const;
const HUB_GROUP_PAGE_SIZE = 100;

function finiteMetric(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function runGroupFields(bundle: Record<string, unknown>): Partial<HubRunSummary> {
  if (bundle.group_run_id === undefined) return {};
  if (
    typeof bundle.group_run_id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(bundle.group_run_id) ||
    bundle.group_run_id === bundle.run_id ||
    typeof bundle.group_member_id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(bundle.group_member_id) ||
    typeof bundle.group_run_number !== 'number' ||
    !Number.isInteger(bundle.group_run_number) ||
    bundle.group_run_number < 1 ||
    typeof bundle.group_total !== 'number' ||
    !Number.isInteger(bundle.group_total) ||
    bundle.group_total < 1 ||
    bundle.group_total > 100000 ||
    typeof bundle.group_timestamp !== 'string' ||
    bundle.group_timestamp.length > 40 ||
    !Number.isFinite(Date.parse(bundle.group_timestamp))
  )
    throw new Error('Invalid Benchmark Hub group membership');
  return {
    group_run_id: bundle.group_run_id,
    group_member_id: bundle.group_member_id,
    group_run_number: bundle.group_run_number,
    group_timestamp: bundle.group_timestamp,
    group_total: bundle.group_total,
  };
}

function runGroupSchedule(bundle: Record<string, unknown>): HubRunSummary['run_group'] {
  if (bundle.run_group === undefined) return undefined;
  if (
    bundle.group_run_id !== undefined ||
    typeof bundle.run_group !== 'object' ||
    bundle.run_group === null ||
    Array.isArray(bundle.run_group)
  ) {
    throw new Error('Invalid Benchmark Hub group schedule');
  }
  const value = bundle.run_group as Record<string, unknown>;
  if (
    !Array.isArray(value.members) ||
    value.members.length < 1 ||
    value.members.length > 100000 ||
    typeof value.status !== 'string' ||
    !['running', 'passed', 'failed', 'cancelled'].includes(value.status)
  ) {
    throw new Error('Invalid Benchmark Hub group schedule');
  }
  const seen = new Set<string>();
  const members = value.members.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid Benchmark Hub group member');
    const member = raw as Record<string, unknown>;
    if (
      typeof member.member_id !== 'string' ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(member.member_id) ||
      seen.has(member.member_id) ||
      typeof member.name !== 'string' ||
      !/^[A-Za-z0-9._-]{1,200}$/.test(member.name) ||
      typeof member.run_number !== 'number' ||
      !Number.isInteger(member.run_number) ||
      member.run_number < 1
    ) {
      throw new Error('Invalid Benchmark Hub group member');
    }
    seen.add(member.member_id);
    return { member_id: member.member_id, name: member.name, run_number: member.run_number };
  });
  if (JSON.stringify(members).length > 10 * 1024 * 1024)
    throw new Error('Benchmark Hub group schedule is oversized');
  const outcomes: NonNullable<HubRunSummary['run_group']>['outcomes'] = {};
  if (value.outcomes !== undefined) {
    if (!value.outcomes || typeof value.outcomes !== 'object' || Array.isArray(value.outcomes))
      throw new Error('Invalid campaign controller outcomes');
    for (const [id, raw] of Object.entries(value.outcomes as Record<string, unknown>)) {
      if (!seen.has(id) || !raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid campaign controller outcome');
      const outcome = raw as Record<string, unknown>;
      if (
        typeof outcome.status !== 'string' ||
        !['queued', 'running', 'passed', 'failed', 'cancelled'].includes(outcome.status) ||
        (outcome.controller_exit_code !== null &&
          (typeof outcome.controller_exit_code !== 'number' ||
            !Number.isInteger(outcome.controller_exit_code) ||
            Math.abs(outcome.controller_exit_code) > 65535))
      ) {
        throw new Error('Invalid campaign controller outcome');
      }
      outcomes[id] = {
        status: outcome.status,
        controller_exit_code: outcome.controller_exit_code as number | null,
      };
    }
  }
  const elapsed =
    value.wall_clock_seconds === null || value.wall_clock_seconds === undefined
      ? null
      : finiteMetric(value.wall_clock_seconds);
  if (
    value.wall_clock_seconds !== null &&
    value.wall_clock_seconds !== undefined &&
    elapsed === null
  )
    throw new Error('Invalid campaign elapsed time');
  const finished =
    value.finished_at === null || value.finished_at === undefined ? null : value.finished_at;
  if (
    finished !== null &&
    (typeof finished !== 'string' || finished.length > 40 || !Number.isFinite(Date.parse(finished)))
  )
    throw new Error('Invalid campaign finish time');
  return {
    members,
    status: value.status,
    outcomes,
    wall_clock_seconds: elapsed,
    finished_at: finished as string | null,
  };
}

/** One immutable schedule and compact child summaries own the visible group. */
function groupedRunCatalog(index: HubRunSummary[], preview = true): HubRunSummary[] {
  const output: HubRunSummary[] = [];
  const owners = new Map(index.filter((run) => run.run_group).map((run) => [run.run_id, run]));
  const members = new Map<string, HubRunSummary[]>();
  for (const run of index) {
    if (run.group_run_id) {
      const children = members.get(run.group_run_id) ?? [];
      children.push(run);
      members.set(run.group_run_id, children);
    } else if (!run.run_group) output.push(run);
  }
  for (const id of new Set([...owners.keys(), ...members.keys()])) {
    const owner = owners.get(id);
    const children = (members.get(id) ?? []).sort((a, b) =>
      (a.group_member_id ?? a.run_id).localeCompare(b.group_member_id ?? b.run_id)
    );
    const byMember = new Map(children.map((child) => [child.group_member_id!, child]));
    const schedule =
      owner?.run_group?.members ??
      children.map((child) => ({
        member_id: child.group_member_id!,
        name: child.tasks[0]?.name ?? 'benchmark',
        run_number: child.group_run_number ?? 1,
      }));
    const tasks: HubRunTaskSummary[] = schedule.flatMap((member) => {
      const child = byMember.get(member.member_id);
      const rows = child?.tasks ?? [
        {
          name: member.name,
          passed: null,
          status: 'queued',
          agent_id: null,
          duration_seconds: null,
          cost_cents: null,
          world_model_mode: null,
          fast_mode: false,
          tree_agent_count: null,
          failure_reason: null,
        },
      ];
      return rows.map((task, slot) => {
        const outcome = owner?.run_group?.outcomes?.[member.member_id];
        const terminalController =
          outcome && ['passed', 'failed', 'cancelled'].includes(outcome.status);
        const pendingTask =
          task.passed === null && !['INFRA_ERROR', 'error', 'cancelled'].includes(task.status);
        const lifecycle =
          terminalController && pendingTask
            ? {
                status: outcome.status === 'cancelled' ? 'cancelled' : 'INFRA_ERROR',
                passed: null,
                lifecycle_stage:
                  task.lifecycle_stage === 'released'
                    ? 'released'
                    : 'controller-terminal-cleanup-unknown',
                failure_reason:
                  outcome.status === 'cancelled'
                    ? 'Campaign controller was cancelled before a benchmark result was published'
                    : `Controller exited with code ${outcome.controller_exit_code ?? 'unknown'} before a benchmark result was published`,
              }
            : {};
        return {
          ...task,
          ...lifecycle,
          row_id: `${member.member_id}-${slot}`,
          ...(child ? { child_run_id: child.run_id } : {}),
          run_number: member.run_number,
        };
      });
    });
    const total = owner
      ? tasks.length
      : Math.max(tasks.length, ...children.map((child) => child.group_total ?? 0));
    const counts = {
      passed: tasks.filter((task) => task.passed === true).length,
      failed: tasks.filter((task) => task.passed === false).length,
      queued:
        tasks.filter(
          (task) =>
            task.passed === null && !['INFRA_ERROR', 'error', 'cancelled'].includes(task.status)
        ).length +
        total -
        tasks.length,
      infra_error: tasks.filter(
        (task) => task.passed === null && ['INFRA_ERROR', 'error'].includes(task.status)
      ).length,
      cancelled: tasks.filter((task) => task.passed === null && task.status === 'cancelled').length,
    };
    const timestamp =
      owner?.timestamp || children[0]?.group_timestamp || children[0]?.timestamp || '';
    const uploadedAt =
      [owner?.uploaded_at ?? '', ...children.map((child) => child.uploaded_at)].sort().at(-1) ?? '';
    const elapsed =
      owner?.run_group?.wall_clock_seconds ??
      (owner?.live ? (Date.now() - Date.parse(timestamp)) / 1000 : null);
    const cost: Record<string, unknown> = {};
    for (const field of ['agents_llm_usd', 'wmh_grounding_usd', 'infra_usd', 'total_usd']) {
      const values = children
        .map((child) => finiteMetric(child.cost?.[field]))
        .filter((value): value is number => value !== null);
      const sum = values.reduce((acc, value) => acc + value, 0);
      cost[field] = values.length && Number.isFinite(sum) ? sum : null;
    }
    cost.fast_cache_hit_rate = null;
    const codes = new Set(children.map((child) => child.code ?? null));
    output.push({
      run_id: id,
      timestamp,
      suite: owner?.suite ?? children[0]?.suite ?? null,
      source: 'benchmark-campaign',
      live: owner ? owner.live : true,
      uploaded_at: uploadedAt,
      tasks: preview ? tasks.slice(0, HUB_GROUP_PAGE_SIZE) : tasks,
      task_counts: counts,
      task_total: total,
      is_group: true,
      code: codes.size === 1 ? [...codes][0] : null,
      elapsed_s: finiteMetric(elapsed),
      cost,
    });
  }
  // Match the physical catalog's newest-started-run ordering, independently of
  // the time that any one member last published.
  return output.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export const putRun = coalesceHubRunPuts(storeRun);

async function storeRun(
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
    ...runGroupFields(bundle),
    ...(bundle.run_group !== undefined ? { run_group: runGroupSchedule(bundle) } : {}),
  };
  const agentIds = agentIdsFromHubBundle(bundle);

  let storedSummary = summary;
  let storedAgentIndexRevision: number | null = null;
  await withIndexLock(async () => {
    const index = await listRunsStrict();
    const existing = index.find((run) => run.run_id === runId);
    if (existing?.run_group || summary.run_group) {
      if ((existing && !existing.run_group) || (existing?.run_group && !summary.run_group)) {
        throw new Error('Benchmark Hub group ID collides with a physical run');
      }
      if (
        existing?.run_group &&
        JSON.stringify(existing.run_group.members) !== JSON.stringify(summary.run_group!.members)
      ) {
        throw new Error('Benchmark Hub group schedule changed');
      }
      if (summary.run_group) {
        const scheduled = new Map(
          summary.run_group.members.map((member) => [member.member_id, member])
        );
        for (const child of index.filter((run) => run.group_run_id === runId)) {
          const member = scheduled.get(child.group_member_id!);
          if (
            !member ||
            member.run_number !== child.group_run_number ||
            child.tasks.length !== 1 ||
            child.tasks[0]?.name !== member.name ||
            summary.run_group.members.length !== child.group_total
          ) {
            throw new Error('Existing Benchmark Hub child differs from its group schedule');
          }
        }
      }
    }
    if (existing?.group_run_id) {
      for (const field of HUB_GROUP_FIELDS) {
        if (summary[field] !== undefined && summary[field] !== existing[field]) {
          throw new Error('Benchmark Hub group membership changed');
        }
      }
      Object.assign(summary, runGroupFields({ ...existing, run_id: runId }));
    }
    if (summary.group_run_id) {
      const owner = index.find((run) => run.run_id === summary.group_run_id);
      if (owner && !owner.run_group)
        throw new Error('Benchmark Hub group ID collides with a physical run');
      if (
        index.some(
          (run) =>
            run.run_id !== runId &&
            run.group_run_id === summary.group_run_id &&
            run.group_member_id === summary.group_member_id
        )
      ) {
        throw new Error('Benchmark Hub group member already belongs to another run');
      }
      if (owner?.run_group) {
        const member = owner.run_group.members.find(
          (item) => item.member_id === summary.group_member_id
        );
        if (
          !member ||
          member.run_number !== summary.group_run_number ||
          tasks.length !== 1 ||
          tasks[0]?.name !== member.name ||
          owner.run_group.members.length !== summary.group_total
        ) {
          throw new Error('Benchmark Hub group member differs from its schedule');
        }
      }
      summary.tasks = tasks.map((task) => ({
        ...taskSummary(task),
        cost_cents: finiteMetric(task.cost_cents),
        duration_seconds: finiteMetric(task.duration_seconds),
        tree_agent_count: finiteMetric(task.tree_agent_count),
        tokens_in: finiteMetric(task.tokens_in),
        tokens_out: finiteMetric(task.tokens_out),
        cache_hit_pct: finiteMetric(task.cache_hit_pct),
        llm_call_count: finiteMetric(task.llm_call_count),
        message_count: finiteMetric(task.message_count),
      }));
      summary.code =
        typeof bundle.code === 'string' && bundle.code.length <= 128 ? bundle.code : null;
      summary.elapsed_s = finiteMetric(bundle.elapsed_s);
      summary.cost =
        typeof bundle.cost === 'object' && bundle.cost !== null
          ? Object.fromEntries(
              [
                'agents_llm_usd',
                'wmh_grounding_usd',
                'infra_usd',
                'total_usd',
                'fast_cache_hit_rate',
              ].map((field) => [
                field,
                finiteMetric((bundle.cost as Record<string, unknown>)[field]),
              ])
            )
          : null;
    }
    // Final is an absorbing state. A snapshot loop already in flight may
    // arrive after completion; it must not regress either the bundle or index
    // back to live/running.
    if (existing !== undefined && !existing.live && summary.live) {
      storedSummary = existing;
      return;
    }
    const persisted = await readAgentRunIndexForMutation(index);
    const agentIndex = hubAgentIndexAfterPut(persisted, index.length === 0, runId, agentIds);
    await putObject(
      `runs/${runId}.json`,
      JSON.stringify({ ...bundle, ...runGroupFields({ ...summary, run_id: runId }) })
    );
    const next = [summary, ...index.filter((r) => r.run_id !== runId)];
    next.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
    await putObject('index.json', JSON.stringify(next));
    await writeAgentRunIndex(agentIndex);
    await putObject(`visibility/${runId}.json`, 'true');
    storedAgentIndexRevision = agentIndex.revision;
  });
  log.info('Stored benchmark run bundle', {
    runId,
    live: storedSummary.live,
    tasks: storedSummary.tasks.length,
  });
  if (storedAgentIndexRevision !== null) {
    await slotHubAncestorSkeletonsFromBundle(bundle);
    applyHubRunToResolutionCaches(runId, agentIds, storedAgentIndexRevision);
  }
  return storedSummary;
}

/**
 * Persist the one-time legacy backfill. Concurrent uploads win for reused ids,
 * and pointers to runs deleted during the scan are discarded.
 */
export async function persistHubAgentRunBackfill(
  backfilled: Map<string, string>
): Promise<HubAgentRunIndexSnapshot> {
  return withIndexLock(async () => {
    const runs = await listRunsStrict();
    const validRunIds = new Set(runs.map((run) => run.run_id));
    const current = await readAgentRunIndexForMutation(runs);
    const snapshot = completedHubAgentBackfill(current, backfilled, validRunIds);
    await writeAgentRunIndex(snapshot);
    return snapshot;
  });
}

export async function listRuns(options: { grouped?: boolean } = {}): Promise<HubRunSummary[]> {
  const raw = await getObject('index.json');
  if (!raw) return [];
  try {
    const runs = parseRunCatalog(raw);
    return options.grouped === true ? groupedRunCatalog(runs) : runs;
  } catch {
    return [];
  }
}

export async function listRunPage(page: { offset?: number; limit?: number } = {}): Promise<{
  runs: HubRunSummary[];
  pagination: { offset: number; limit: number; total: number };
}> {
  const runs = await listRuns({ grouped: true });
  const offset = Number.isInteger(page.offset) && page.offset! >= 0 ? page.offset! : 0;
  const limit =
    Number.isInteger(page.limit) && page.limit! > 0
      ? Math.min(page.limit!, HUB_GROUP_PAGE_SIZE)
      : HUB_GROUP_PAGE_SIZE;
  return {
    runs: runs.slice(offset, offset + limit),
    pagination: { offset, limit, total: runs.length },
  };
}

function parseRunCatalog(raw: string): HubRunSummary[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('Invalid Benchmark Hub run catalog');
  return parsed.map((value) => {
    if (
      typeof value !== 'object' ||
      value === null ||
      typeof (value as Partial<HubRunSummary>).run_id !== 'string' ||
      !/^[A-Za-z0-9._-]+$/.test((value as Partial<HubRunSummary>).run_id as string) ||
      !Array.isArray((value as Partial<HubRunSummary>).tasks)
    ) {
      throw new Error('Invalid Benchmark Hub run catalog entry');
    }
    const run = value as HubRunSummary;
    return {
      ...run,
      tasks: run.tasks.map((task) => ({ ...task, agent_id: normalizeAgentId(task.agent_id) })),
    };
  });
}

/** Mutations and migrations must distinguish a missing catalog from read/corruption faults. */
export async function listRunsStrict(): Promise<HubRunSummary[]> {
  const raw = await getObjectStrict('index.json');
  return raw === null ? [] : parseRunCatalog(raw);
}

export async function getRunBundle(runId: string): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  const raw = await getObject(`runs/${runId}.json`);
  if (!raw) return null;
  try {
    return parseHubRunBundle(raw);
  } catch {
    return null;
  }
}

/** Agent resolution preserves transport faults so callers do not cache a false miss. */
export async function getRunBundleForAgentLookup(
  runId: string
): Promise<Record<string, unknown> | null> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) return null;
  let raw: string | null;
  try {
    raw = await getObjectStrict(`runs/${runId}.json`);
  } catch (error: unknown) {
    log.warn('Benchmark Hub run bundle read is temporarily unavailable', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new BenchmarkHubUnavailableError(
      'Benchmark Hub run bundle is temporarily unavailable; retry shortly'
    );
  }
  if (raw === null) return null;
  try {
    return parseHubRunBundle(raw);
  } catch (error: unknown) {
    log.warn('Benchmark Hub run bundle is malformed', {
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function parseHubRunBundle(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Array.isArray((parsed as Record<string, unknown>).tasks)
  ) {
    throw new Error('Invalid Benchmark Hub run bundle');
  }
  return parsed as Record<string, unknown>;
}

/** Legacy-index migration must distinguish an absent/corrupt bundle from success. */
export async function getRunBundleStrict(runId: string): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`Invalid Hub run id: ${runId}`);
  const raw = await getObjectStrict(`runs/${runId}.json`);
  if (raw === null) throw new Error(`Missing Hub run bundle: ${runId}`);
  return parseHubRunBundle(raw);
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

export interface HubRunDetail extends Omit<HubRunSummary, 'tasks' | 'cost'> {
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
  pagination?: { offset: number; limit: number; total: number };
}

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
  const totals = {
    passed: tasks.filter((t) => t.passed === true).length,
    failed: tasks.filter((t) => t.passed === false).length,
    running: tasks.filter(
      (t) => t.passed === null && !['INFRA_ERROR', 'error', 'cancelled'].includes(t.status)
    ).length,
    cost_cents: tasks.reduce((s, t) => s + (t.cost_cents ?? 0), 0),
    tokens_in: tasks.reduce((s, t) => s + (t.tokens_in ?? 0), 0),
    tokens_out: tasks.reduce((s, t) => s + (t.tokens_out ?? 0), 0),
    agents: tasks.reduce((s, t) => s + (t.tree_agent_count ?? 0), 0),
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

/**
 * Remove a run from the index (bundle object is left in place — index removal
 * hides it everywhere; object lifecycle is handled by bucket retention).
 * Returns false when the run id was not present.
 */
export async function deleteRun(runId: string): Promise<boolean> {
  const retired: Array<{ runId: string; bundle: Record<string, unknown> }> = [];
  const removed = await withIndexLock(async () => {
    const index = await listRunsStrict();
    const targets = index.filter((run) => run.run_id === runId || run.group_run_id === runId);
    if (!targets.length) return false;
    // Validate every exact owned bundle before the catalog becomes invisible.
    for (let start = 0; start < targets.length; start += 4) {
      retired.push(
        ...(await Promise.all(
          targets.slice(start, start + 4).map(async (run) => ({
            runId: run.run_id,
            bundle: await getRunBundleStrict(run.run_id),
          }))
        ))
      );
    }
    const ids = new Set(targets.map((run) => run.run_id));
    const next = index.filter((run) => !ids.has(run.run_id));
    let agentIndex = await readAgentRunIndexForMutation(next);
    for (const target of targets) {
      await putObject(`visibility/${target.run_id}.json`, 'false');
      if (agentIndex !== null) agentIndex = hubAgentIndexAfterDelete(agentIndex, target.run_id);
    }
    await putObject('index.json', JSON.stringify(next));
    if (agentIndex !== null) await writeAgentRunIndex(agentIndex);
    return true;
  });
  if (removed)
    for (const target of retired) {
      await deleteHubAncestorSkeletonsFromBundle(target.bundle);
      forgetHubRunFromResolutionCaches(target.runId, agentIdsFromHubBundle(target.bundle));
    }
  return removed;
}

/** Test-only: reset in-process state (local dir is controlled by the caller). */
export function _resetForTests(): void {
  s3Client = null;
  __resetHubResolutionCachesForTest();
}
