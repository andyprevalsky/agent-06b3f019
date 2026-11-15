#!/usr/bin/env tsx
/**
 * Versioned R2 lossless audit (V13) — proves the encrypted trace archive is
 * lossless for a time window. READ-ONLY everywhere: every prod DB query runs
 * inside one `SET TRANSACTION READ ONLY` transaction that is always rolled
 * back; R2 and Supabase are only listed/read. The only local write is the
 * unknown-bundle snapshot under --state-dir (and --out when given).
 *
 *   npx tsx scripts/audit-r2-lossless.ts --since 2026-11-13T00:00Z --until 2026-11-14T00:00Z
 *   npx tsx scripts/audit-r2-lossless.ts --since ... --v2-cutoff <deploy time> --json --out report.json
 *
 * Checks (named PASS/FAIL/WARN/UNVERIFIED/SKIP lines): C0 record_integrity,
 * C1 terminal_roots_finalized, C2 llm_calls_have_final_output, C3
 * no_unbound_or_nonroot_writes, C4 v2_schema_valid, C5 code_checkpoints_mirrored,
 * C6 backend_call_sites_recorded. Exit 1 on any FAIL, 2 on audit error.
 *
 * Window scope: roots created in [since, until) plus every older root whose
 * tree recorded a ToolUsage row in the window; the tree, ledger and bundle
 * checks all use that one root set.
 */
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { config } from 'dotenv';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import { withTraceArchiveRequestTimeout } from '../src/providers/traceArchiveRequest';
import { localArchiveRoot } from '../src/providers/traceArchivePaths';
import {
  type ArchiveSource,
  type BundleScan,
  type CheckpointSource,
  type Inventory,
  type ListResult,
  type RootRow,
  archiveEncryptionKey,
  isUserRoot,
  isUuid,
  localArchiveSource,
  mapLimit,
} from './audit-r2-lossless-core';
import { renderHuman, runAudit } from './audit-r2-lossless-engine';
import { loadRecordSchema } from './audit-r2-lossless-schema';

export interface CliArgs {
  sinceMs: number;
  untilMs: number;
  v2CutoffMs: number | null;
  json: boolean;
  out: string | null;
  concurrency: number;
  graceMinutes: number;
  maxExamples: number;
  roots: string[];
  backend: 'r2' | 'local';
  bundleScan: boolean;
  orphanSample: number;
  orphanSweepFull: boolean;
  stateDir: string;
  supabase: boolean;
}

function parseTime(flag: string, value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${flag}: invalid timestamp ${value}`);
  return ms;
}

export function parseArgs(argv: string[], nowMs = Date.now()): CliArgs {
  const startOfToday = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const args: CliArgs = {
    sinceMs: startOfToday - 86_400_000,
    untilMs: Number.NaN,
    v2CutoffMs: null,
    json: false,
    out: null,
    concurrency: 64,
    graceMinutes: 60,
    maxExamples: 5,
    roots: [],
    backend:
      (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase() === 'local' ? 'local' : 'r2',
    bundleScan: true,
    orphanSample: 5000,
    orphanSweepFull: false,
    stateDir: path.resolve(__dirname, '..', '..', '.context', 'r2-lossless-audit'),
    supabase: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    const positive = (): number => {
      const value = Number(next());
      if (!Number.isInteger(value) || value < 0)
        throw new Error(`${arg} must be a non-negative integer`);
      return value;
    };
    if (arg === '--since') args.sinceMs = parseTime(arg, next());
    else if (arg === '--until') args.untilMs = parseTime(arg, next());
    else if (arg === '--v2-cutoff') args.v2CutoffMs = parseTime(arg, next());
    else if (arg === '--json') args.json = true;
    else if (arg === '--out') args.out = path.resolve(next());
    else if (arg === '--concurrency') args.concurrency = Math.max(1, positive());
    else if (arg === '--grace-minutes') args.graceMinutes = positive();
    else if (arg === '--max-examples') args.maxExamples = positive();
    else if (arg === '--root') args.roots.push(next());
    else if (arg === '--backend') {
      const value = next();
      if (value !== 'r2' && value !== 'local') throw new Error('--backend must be r2 or local');
      args.backend = value;
    } else if (arg === '--no-bundle-scan') args.bundleScan = false;
    else if (arg === '--orphan-sample') args.orphanSample = positive();
    else if (arg === '--orphan-sweep-full') args.orphanSweepFull = true;
    else if (arg === '--state-dir') args.stateDir = path.resolve(next());
    else if (arg === '--no-supabase') args.supabase = false;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (Number.isNaN(args.untilMs)) args.untilMs = args.sinceMs + 86_400_000;
  if (args.untilMs <= args.sinceMs) throw new Error('--until must be after --since');
  return args;
}

// ── Sources ──

export function r2Source(concurrency: number): { source: ArchiveSource; bucket: string } {
  const bucket = process.env.R2_BUCKET_TRACE_ARCHIVE || '';
  if (bucket === '' || !process.env.R2_ACCOUNT_ID)
    throw new Error('R2 trace archive is not configured');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
    maxAttempts: 8,
    retryMode: 'adaptive',
    // Nested sharded listings queue behind the socket pool by design; that is not a fault.
    requestHandler: {
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: concurrency * 4 }),
      socketAcquisitionWarningTimeout: 120_000,
    },
  });
  const source: ArchiveSource = {
    kind: `r2:${bucket}`,
    async list(prefix, delimiter, maxPages) {
      const result: ListResult = { objects: [], prefixes: [], truncated: false };
      let token: string | undefined;
      let pages = 0;
      do {
        const response = await withTraceArchiveRequestTimeout((abortSignal) =>
          client.send(
            new ListObjectsV2Command({
              Bucket: bucket,
              Prefix: prefix,
              Delimiter: delimiter,
              ContinuationToken: token,
              MaxKeys: 1000,
            }),
            { abortSignal }
          )
        );
        for (const item of response.Contents ?? []) {
          if (item.Key === undefined) continue;
          result.objects.push({
            key: item.Key,
            size: item.Size ?? 0,
            lastModifiedMs: item.LastModified?.getTime() ?? 0,
          });
        }
        for (const p of response.CommonPrefixes ?? [])
          if (p.Prefix !== undefined) result.prefixes.push(p.Prefix);
        token = response.IsTruncated ? response.NextContinuationToken : undefined;
        pages += 1;
        if (token !== undefined && maxPages !== undefined && pages >= maxPages) {
          result.truncated = true;
          break;
        }
      } while (token !== undefined);
      return result;
    },
    async get(key, rangeBytes) {
      try {
        return await withTraceArchiveRequestTimeout(async (abortSignal) => {
          const response = await client.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: key,
              Range: rangeBytes === undefined ? undefined : `bytes=0-${rangeBytes - 1}`,
            }),
            { abortSignal }
          );
          return Buffer.from(await response.Body!.transformToByteArray());
        });
      } catch (error) {
        const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404)
          return null;
        throw error;
      }
    },
  };
  return { source, bucket };
}

function supabaseCheckpoints(): CheckpointSource | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const storage = createClient(url, key, { auth: { persistSession: false } }).storage.from(
    'attachments'
  );
  return {
    async listSeqs(userId, sessionId) {
      const { data, error } = await storage.list(`user/${userId}/code-sessions/${sessionId}`, {
        limit: 1000,
      });
      if (error) throw new Error(`Supabase list failed for ${sessionId}: ${error.message}`);
      return (data ?? [])
        .map((entry) => Number(entry.name))
        .filter((n) => Number.isInteger(n) && n > 0);
    },
    async readManifest(userId, sessionId, seq) {
      const { data, error } = await storage.download(
        `user/${userId}/code-sessions/${sessionId}/${seq}/manifest.json`
      );
      if (error || !data) return null;
      return JSON.parse(Buffer.from(await data.arrayBuffer()).toString('utf8')) as never;
    },
  };
}

/** All bundle ids under trace-archive/, listed in parallel shards (hex first chars split twice). */
export async function listAllBundleIds(
  source: ArchiveSource,
  concurrency: number
): Promise<string[]> {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_.-';
  const shards = [...alphabet].flatMap((c) =>
    /[0-9a-f]/.test(c) ? [...alphabet].map((d) => c + d) : [c]
  );
  const lists = await mapLimit(shards, concurrency, (shard) =>
    source.list(`trace-archive/${shard}`, '/')
  );
  return [...new Set(lists.flatMap((l) => l.prefixes.map((p) => p.split('/')[1]).filter(Boolean)))];
}

// ── Read-only prod inventory ──

const ROLLBACK = new Error('rollback');
const sqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/**
 * Window root filter on `"Agent" a` ($1 since, $2 until): roots created in the
 * window, plus older roots whose tree (the root or any descendant) recorded a
 * ToolUsage row in it, so a long-running root's later calls are audited on the
 * days they happen.
 */
export const WINDOW_ROOTS_SQL = `((a."createdAt" >= $1::timestamp AND a."createdAt" < $2::timestamp)
  OR a.id IN (WITH RECURSIVE up(id, parent, depth) AS (
      SELECT g.id, g."parentAgentId", 0 FROM "Agent" g
        WHERE g.id IN (SELECT tu."agentId" FROM "ToolUsage" tu
          WHERE tu."createdAt" >= $1::timestamp AND tu."createdAt" < $2::timestamp)
      UNION
      SELECT p.id, p."parentAgentId", u.depth + 1 FROM "Agent" p
        JOIN up u ON p.id = u.parent WHERE u.depth < 64)
    SELECT id FROM up WHERE parent IS NULL))`;

interface Membership {
  id: string;
  is_root: boolean;
  model: string;
}

async function readInventory(
  args: CliArgs,
  bundleIds: string[] | null
): Promise<{ inventory: Inventory; membership: Membership[] }> {
  const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('DIRECT_URL/DATABASE_URL is not set');
  const prisma = new PrismaClient({ datasourceUrl: url });
  let inventory: Inventory | null = null;
  const membership: Membership[] = [];
  try {
    await prisma
      .$transaction(
        async (tx) => {
          // First statement: nothing in this transaction can write. Rolled back below.
          await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
          await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '240s'");
          const since = sqlTime(args.sinceMs);
          const until = sqlTime(args.untilMs);
          const rootSql = `SELECT a.id, a."createdAt", a."updatedAt", a.status::text AS status,
              (a."deletedAt" IS NOT NULL) AS deleted, a."isBenchmark", a.model,
              (a."temporalWorkflowId" IS NOT NULL OR a."workflowStartPhase" IS NOT NULL) AS has_workflow
            FROM "Agent" a WHERE a."parentAgentId" IS NULL AND `;
          type RootSql = {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            status: string;
            deleted: boolean;
            isBenchmark: boolean;
            model: string;
            has_workflow: boolean;
          };
          const rawRoots =
            args.roots.length > 0
              ? await tx.$queryRawUnsafe<RootSql[]>(`${rootSql} a.id = ANY($1::text[])`, args.roots)
              : await tx.$queryRawUnsafe<RootSql[]>(`${rootSql} ${WINDOW_ROOTS_SQL}`, since, until);
          const rows: RootRow[] = rawRoots.map((r) => ({
            id: r.id,
            createdAtMs: r.createdAt.getTime(),
            updatedAtMs: r.updatedAt.getTime(),
            status: r.status,
            deleted: r.deleted,
            isBenchmark: r.isBenchmark,
            model: r.model,
            hasWorkflow: r.has_workflow,
          }));
          const roots = rows.filter((r) => r.model !== 'benchmark-hub');
          const rootIds = roots.map((r) => r.id);
          const tree = `WITH RECURSIVE tree(id, root) AS (
              SELECT a.id, a.id FROM "Agent" a WHERE a.id = ANY($1::text[])
              UNION ALL SELECT c.id, t.root FROM "Agent" c JOIN tree t ON c."parentAgentId" = t.id)`;
          const treeAgents = await tx.$queryRawUnsafe<Array<{ id: string; root: string }>>(
            `${tree} SELECT id, root FROM tree WHERE id <> root`,
            rootIds
          );
          const ledger = await tx.$queryRawUnsafe<
            Array<{
              id: string;
              agent_id: string;
              root: string;
              tool_name: string;
              item_type: string | null;
              call_site: string | null;
              provider: string | null;
              cache_sequence_id: string | null;
              from_fast_cache: boolean | null;
              cancelled: boolean | null;
            }>
          >(
            `${tree} SELECT tu.id, tu."agentId" AS agent_id, t.root, tu."toolName" AS tool_name,
                e->>'type' AS item_type, e->>'call_site' AS call_site,
                e->>'provider' AS provider, e->>'cache_sequence_id' AS cache_sequence_id,
                (e->>'from_fast_cache') = 'true' AS from_fast_cache,
                (coalesce(e->>'cancelled', '') = 'true' OR coalesce(e->>'status', '') IN ('cancelled', 'canceled')) AS cancelled
              FROM tree t JOIN "ToolUsage" tu ON tu."agentId" = t.id
              CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(tu."usageItems"::jsonb) = 'array'
                THEN tu."usageItems"::jsonb ELSE '[]'::jsonb END) e`,
            rootIds
          );
          const activeChildren = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            `SELECT id FROM "Agent" WHERE "parentAgentId" IS NOT NULL AND "updatedAt" >= $1::timestamp
               AND "createdAt" < $2::timestamp AND model <> 'benchmark-hub'`,
            since,
            until
          );
          const codeSessions = await tx.$queryRawUnsafe<
            Array<{
              id: string;
              userId: string;
              rootAgentId: string;
              state: string;
              latestCheckpointSeq: number;
            }>
          >(
            `SELECT id, "userId", "rootAgentId", state, "latestCheckpointSeq" FROM "CodeSession"
              WHERE "rootAgentId" = ANY($1::text[]) OR ("lastActiveAt" >= $2::timestamp AND "createdAt" < $3::timestamp)`,
            rootIds,
            since,
            until
          );
          // The mirror's root resolver (archiveRootResolver.ts) in SQL: busId, else the
          // parentAgentId walk (at most 8 hops); an unknown agent is its own root.
          const sessionRoots = await tx.$queryRawUnsafe<Array<{ start: string; root: string }>>(
            `WITH RECURSIVE walk(start, cur, depth, stop) AS (
                SELECT x.id, x.id, 0, false FROM unnest($1::text[]) AS x(id)
                UNION ALL
                SELECT w.start,
                  CASE WHEN coalesce(a."busId", '') <> '' THEN a."busId" ELSE a."parentAgentId" END,
                  w.depth + 1, coalesce(a."busId", '') <> ''
                FROM walk w JOIN "Agent" a ON a.id = w.cur
                WHERE NOT w.stop AND w.depth <= 8
                  AND (coalesce(a."busId", '') <> '' OR coalesce(a."parentAgentId", '') <> ''))
              SELECT DISTINCT ON (start) start, cur AS root FROM walk ORDER BY start, depth DESC`,
            [...new Set(codeSessions.map((s) => s.rootAgentId))]
          );
          const archiveRootOf = new Map(sessionRoots.map((r) => [r.start, r.root]));
          for (let i = 0; bundleIds !== null && i < bundleIds.length; i += 10_000) {
            membership.push(
              ...(await tx.$queryRawUnsafe<Membership[]>(
                `SELECT id, ("parentAgentId" IS NULL) AS is_root, model FROM "Agent" WHERE id = ANY($1::text[])`,
                bundleIds.slice(i, i + 10_000)
              ))
            );
          }
          inventory = {
            roots,
            hubRoots: rows.filter((r) => r.model === 'benchmark-hub'),
            treeAgents: treeAgents.map((a) => ({ id: a.id, rootId: a.root })),
            activeChildren: activeChildren.map((a) => a.id),
            ledger: ledger.map((l) => ({
              toolUsageId: l.id,
              agentId: l.agent_id,
              rootId: l.root,
              toolName: l.tool_name,
              itemType: l.item_type,
              callSite: l.call_site,
              provider: l.provider,
              cacheSequenceId: l.cache_sequence_id,
              fromFastCache: l.from_fast_cache === true,
              cancelled: l.cancelled === true,
            })),
            codeSessions: codeSessions.map((s) => ({
              ...s,
              archiveRootAgentId: archiveRootOf.get(s.rootAgentId) ?? s.rootAgentId,
              latestCheckpointSeq: Number(s.latestCheckpointSeq),
            })),
            bundleScan: null,
          };
          throw ROLLBACK; // always roll back
        },
        { timeout: 600_000, maxWait: 30_000 }
      )
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });
  } finally {
    await prisma.$disconnect();
  }
  if (inventory === null) throw new Error('inventory transaction produced no result');
  return { inventory, membership };
}

// ── Unknown-bundle snapshot (local state only) ──

/** id -> first time an audit saw it as an unknown bundle (an upper bound on its creation). */
function readSnapshot(stateDir: string): Map<string, number> | null {
  const file = path.join(stateDir, 'unknown-bundles.json');
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    first_seen?: Record<string, number>;
    ids?: string[];
  };
  // Bare-id snapshots (first prototype) are a baseline: first seen "before any audit".
  const legacy = Object.fromEntries((parsed.ids ?? []).map((id) => [id, 0]));
  return new Map(Object.entries(parsed.first_seen ?? legacy));
}

function writeSnapshot(
  stateDir: string,
  ids: string[],
  previous: Map<string, number> | null,
  nowMs: number
): void {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'unknown-bundles.json');
  const temporary = `${file}.${process.pid}.tmp`;
  // The first snapshot is a baseline (0 = existed before any audit); later ids get the time a
  // run first saw them, an upper bound on their creation.
  const firstSeen = Object.fromEntries(
    ids.map((id) => [id, previous === null ? 0 : (previous.get(id) ?? nowMs)])
  );
  fs.writeFileSync(
    temporary,
    JSON.stringify({ saved_at: new Date(nowMs).toISOString(), first_seen: firstSeen }),
    { mode: 0o600 }
  );
  fs.renameSync(temporary, file);
}

/** Deterministic sample per window (mulberry32), so reruns of a day audit the same ids. */
export function seededRandom(seed: number): () => number {
  let state = Math.floor(seed / 1000) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Unknown bundles first seen at/after the window start (or never seen) are
 * listed exactly; the rest are sampled (all of them with --orphan-sweep-full).
 */
export function planBundleScan(
  allIds: string[],
  membership: Array<{ id: string; is_root: boolean; model: string }>,
  previous: Map<string, number> | null,
  sinceMs: number,
  sample: number,
  sweepFull: boolean,
  random: () => number = Math.random
): BundleScan {
  const known = new Map(membership.map((m) => [m.id, m]));
  const unknown = allIds.filter((id) => isUuid(id) && !known.has(id));
  const fresh =
    previous === null
      ? []
      : unknown.filter((id) => !previous.has(id) || (previous.get(id) ?? 0) >= sinceMs);
  const freshSet = new Set(fresh);
  const rest = unknown.filter((id) => !freshSet.has(id));
  const shuffled = [...rest];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return {
    totalBundles: allIds.length,
    nonUuid: allIds.filter((id) => !isUuid(id) && !isUserRoot(id)),
    userRootBundles: allIds.filter(isUserRoot),
    childAgentBundles: membership
      .filter((m) => !m.is_root && m.model !== 'benchmark-hub')
      .map((m) => m.id),
    unknownUuidTotal: unknown.length,
    newUnknownUuid: fresh,
    sampledUnknownUuid: sweepFull ? rest : shuffled.slice(0, sample),
    snapshotAvailable: previous !== null,
  };
}

async function main(): Promise<void> {
  config(); // back-end/.env; loaded here so importing this module (tests) never reads prod credentials
  const args = parseArgs(process.argv.slice(2));
  const nowMs = Date.now();
  const archive =
    args.backend === 'local'
      ? localArchiveSource(localArchiveRoot())
      : r2Source(args.concurrency).source;
  const log = (message: string) => process.stderr.write(`${message}\n`);
  const bundleIds = args.bundleScan ? await listAllBundleIds(archive, args.concurrency) : null;
  if (bundleIds !== null) log(`[audit] listed ${bundleIds.length} bundle ids under trace-archive/`);
  const { inventory, membership } = await readInventory(args, bundleIds?.filter(isUuid) ?? null);
  log(
    `[audit] inventory roots=${inventory.roots.length} hub=${inventory.hubRoots.length} ledger=${inventory.ledger.length} code_sessions=${inventory.codeSessions.length}`
  );
  let unknownIds: string[] = [];
  let previous: Map<string, number> | null = null;
  if (bundleIds !== null) {
    previous = readSnapshot(args.stateDir);
    inventory.bundleScan = planBundleScan(
      bundleIds,
      membership,
      previous,
      args.sinceMs,
      args.orphanSample,
      args.orphanSweepFull,
      seededRandom(args.sinceMs)
    );
    const known = new Set(membership.map((m) => m.id));
    unknownIds = bundleIds.filter((id) => isUuid(id) && !known.has(id));
  }
  const report = await runAudit(inventory, archive, args.supabase ? supabaseCheckpoints() : null, {
    sinceMs: args.sinceMs,
    untilMs: args.untilMs,
    nowMs,
    v2CutoffMs: args.v2CutoffMs,
    graceMs: args.graceMinutes * 60_000,
    concurrency: args.concurrency,
    maxExamples: args.maxExamples,
    headBytes: 65_536,
    encryptionKey: archiveEncryptionKey(),
    schema: loadRecordSchema(),
    log,
  });
  if (bundleIds !== null && args.backend === 'r2')
    writeSnapshot(args.stateDir, unknownIds, previous, nowMs);
  const human = renderHuman(report);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out !== null) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, json, { mode: 0o600 });
  }
  if (args.json) {
    process.stderr.write(`${human}\n`);
    process.stdout.write(json);
  } else process.stdout.write(`${human}\n`);
  process.exitCode = report.result === 'FAIL' ? 1 : 0;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `audit-r2-lossless: ${error instanceof Error ? error.stack : String(error)}\n`
    );
    process.exitCode = 2;
  });
}
