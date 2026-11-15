/** Materialized, user-scoped grep index for encrypted trace bundles in R2. */

import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from './database';
import {
  decryptAndValidateArtifact,
  listArchivedObjectsStrict,
  readArchivedArtifactStrict,
} from './traceArchive';
import { withArchiveManifestLock } from './traceArchiveManifest';
import type { ScopedDbFixture } from './traceArchiveFixture';

const END_FIXTURE_PATH = 'db/end.fixture.json.gz.enc';
const TRACE_ROLES = new Set(['USER', 'ASSISTANT', 'TOOL']);
const WRITE_BATCH_SIZE = 100;

type RecordValue = Record<string, unknown>;

export interface ArchivedTrajectoryRow {
  messageId: string;
  userId: string;
  rootAgentId: string;
  agentId: string;
  surface: string;
  role: string;
  createdAt: Date;
  searchText: string;
  agentGoal: string;
  agentTitle: string | null;
  archivePath: string;
  traceKind: string;
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function date(value: unknown, fallback: Date): Date {
  const candidate =
    value instanceof Date
      ? value
      : typeof value === 'number'
        ? new Date(value)
        : new Date(String(value ?? ''));
  return Number.isNaN(candidate.getTime()) ? fallback : candidate;
}

function textParts(value: unknown, depth = 0): string[] {
  if (depth > 8 || value === null || value === undefined) return [];
  if (typeof value === 'string') {
    return value.startsWith('data:image/') || value.startsWith('data:audio/') ? [] : [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => textParts(item, depth + 1));
  const object = record(value);
  if (object === null || ['image', 'image_url', 'audio', 'video'].includes(String(object.type))) {
    return [];
  }
  return ['text', 'content', 'output', 'arguments', 'result'].flatMap((key) =>
    textParts(object[key], depth + 1)
  );
}

/**
 * Assistant text of one archived call, for both record layouts:
 *   v2 / Python  → output.content + output.tool_calls[].arguments
 *   legacy TS    → extra.output + extra.tool_calls[].arguments
 */
function llmOutputText(dump: RecordValue): string {
  const output = record(dump.output);
  const extra = record(dump.extra);
  const parts = output
    ? [...textParts(output), ...textParts(output.tool_calls)]
    : [...textParts(dump.output), ...textParts(extra?.output), ...textParts(extra?.tool_calls)];
  return parts.join('\n').trim();
}

function archivedMessageRows(fixture: ScopedDbFixture): ArchivedTrajectoryRow[] {
  const rootAgentId = fixture.root_agent_id;
  const agents = new Map(
    (fixture.rows.Agent ?? [])
      .map(record)
      .filter((agent): agent is RecordValue => agent !== null && string(agent.id) !== null)
      .map((agent) => [String(agent.id), agent])
  );
  const fallback = date(fixture.captured_at, new Date(0));
  return (fixture.rows.Message ?? []).flatMap((entry) => {
    const message = record(entry);
    const id = string(message?.id);
    const agentId = string(message?.agentId);
    const role = string(message?.role)?.toUpperCase();
    const searchText = string(message?.text);
    if (!id || !agentId || !role || !TRACE_ROLES.has(role) || !searchText) return [];
    const agent = agents.get(agentId);
    return [
      {
        messageId: id,
        userId: fixture.user_id,
        rootAgentId,
        agentId,
        surface: string(agent?.source) ?? 'WEB',
        role,
        createdAt: date(message?.createdAt ?? message?.timestamp, fallback),
        searchText,
        agentGoal: string(agent?.goal) ?? '',
        agentTitle: string(agent?.title),
        archivePath: END_FIXTURE_PATH,
        traceKind: 'message',
      },
    ];
  });
}

function contentDigest(rootAgentId: string, agentId: string, role: string, text: string): string {
  return createHash('sha256').update(`${rootAgentId}\0${agentId}\0${role}\0${text}`).digest('hex');
}

function llmRows(
  fixture: ScopedDbFixture,
  artifactPath: string,
  payload: unknown,
  seen: Set<string>,
  partialArchive: boolean
): ArchivedTrajectoryRow[] {
  const wrapper = record(payload);
  const dump = wrapper?.kind === 'legacy-llm-dump' ? record(wrapper.payload) : wrapper;
  if (dump === null) return [];
  if (string(dump.root_agent_id) !== null && dump.root_agent_id !== fixture.root_agent_id)
    return [];
  const agentId = string(dump.agent_id) ?? fixture.root_agent_id;
  if (
    !(fixture.agent_ids ?? []).includes(agentId) &&
    !(partialArchive && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(agentId))
  )
    return [];
  const agent = (fixture.rows.Agent ?? []).map(record).find((row) => row?.id === agentId);
  const createdAt = date(
    dump.started_at_ms ?? dump.finished_at_ms ?? dump.ts_ms ?? dump.ingested_ms ?? dump.created_at,
    date(fixture.captured_at, new Date(0))
  );
  const candidates: Array<{ role: string; kind: string; text: string }> = [];
  for (const message of Array.isArray(dump.messages) ? dump.messages : []) {
    const entry = record(message);
    const role = string(entry?.role)?.toUpperCase();
    if (!role || !TRACE_ROLES.has(role)) continue;
    const text = textParts(entry?.content ?? entry?.text)
      .join('\n')
      .trim();
    // Some LLM dumps flatten stored SYSTEM turns into a user turn with this
    // prefix. Treat those as SYSTEM content, regardless of the wrapper role.
    if (role === 'USER' && /^\[SYSTEM\]:/i.test(text)) continue;
    if (text) candidates.push({ role, kind: 'llm_context', text });
  }
  const output = llmOutputText(dump);
  if (output) candidates.push({ role: 'ASSISTANT', kind: 'llm_output', text: output });
  return candidates.flatMap((candidate) => {
    const digest = contentDigest(fixture.root_agent_id, agentId, candidate.role, candidate.text);
    if (seen.has(digest)) return [];
    seen.add(digest);
    return [
      {
        messageId: `llm-${digest}`,
        userId: fixture.user_id,
        rootAgentId: fixture.root_agent_id,
        agentId,
        surface: string(agent?.source) ?? 'WEB',
        role: candidate.role,
        createdAt,
        searchText: candidate.text,
        agentGoal: string(agent?.goal) ?? '',
        agentTitle: string(agent?.title),
        archivePath: artifactPath,
        traceKind: candidate.kind,
      },
    ];
  });
}

async function readJson(rootAgentId: string, objectPath: string): Promise<unknown> {
  const artifact = await readArchivedArtifactStrict({ rootAgentId, objectPath });
  if (artifact === null) throw new ArchivedTraceNotFoundError(rootAgentId, objectPath);
  return JSON.parse(decryptAndValidateArtifact(artifact).toString('utf8')) as unknown;
}

export class ArchivedTraceNotFoundError extends Error {
  constructor(rootAgentId: string, objectPath: string) {
    super(`Missing archived trace ${rootAgentId}/${objectPath}`);
    this.name = 'ArchivedTraceNotFoundError';
  }
}

/**
 * Each agent's goal and title live once in AgentTrajectoryAgent; message rows
 * store '' / NULL (prod copied ~2.3 GB of goals onto every row). Readers join
 * the agent row and still prefer a legacy row's own non-empty copy.
 */
function upsertTrajectoryAgentsSql(rows: ArchivedTrajectoryRow[]): Prisma.Sql | null {
  const agents = new Map<string, ArchivedTrajectoryRow>();
  for (const row of rows) {
    // An agent missing from a partial fixture has no metadata; writing it would
    // blank the real goal/title the Message trigger already stored.
    if (row.agentGoal !== '' || row.agentTitle !== null) agents.set(row.agentId, row);
  }
  if (agents.size === 0) return null;
  return Prisma.sql`
    INSERT INTO "AgentTrajectoryAgent" ("agentId", "userId", "agentGoal", "agentTitle", "updatedAt")
    VALUES ${Prisma.join(
      [...agents.values()].map(
        (row) =>
          Prisma.sql`(${row.agentId}, ${row.userId}, ${row.agentGoal}, ${row.agentTitle}, CURRENT_TIMESTAMP)`
      )
    )}
    ON CONFLICT ("agentId") DO UPDATE SET
      "agentGoal" = EXCLUDED."agentGoal",
      "agentTitle" = EXCLUDED."agentTitle",
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "AgentTrajectoryAgent"."userId" = EXCLUDED."userId"
      AND ("AgentTrajectoryAgent"."agentGoal", "AgentTrajectoryAgent"."agentTitle")
        IS DISTINCT FROM (EXCLUDED."agentGoal", EXCLUDED."agentTitle")
  `;
}

type SqlExecutor = { $executeRaw(query: Prisma.Sql): Promise<number> };

async function writeTrajectoryRows(
  db: SqlExecutor,
  rows: ArchivedTrajectoryRow[],
  rowsSql: (batch: ArchivedTrajectoryRow[]) => Prisma.Sql
): Promise<void> {
  for (let start = 0; start < rows.length; start += WRITE_BATCH_SIZE) {
    const batch = rows.slice(start, start + WRITE_BATCH_SIZE);
    const agentsSql = upsertTrajectoryAgentsSql(batch);
    if (agentsSql !== null) await db.$executeRaw(agentsSql);
    await db.$executeRaw(rowsSql(batch));
  }
}

function insertRowsSql(batch: ArchivedTrajectoryRow[]): Prisma.Sql {
  return Prisma.sql`
      INSERT INTO "AgentTrajectorySearch" (
        "messageId", "userId", "rootAgentId", "agentId", surface, role,
        "createdAt", "searchText", "agentGoal", "agentTitle", "archivePath", "traceKind"
      ) VALUES ${Prisma.join(
        batch.map(
          (row) => Prisma.sql`(
        ${row.messageId}, ${row.userId}, ${row.rootAgentId}, ${row.agentId},
        ${row.surface}, ${row.role}, ${row.createdAt}, ${row.searchText},
        '', NULL, ${row.archivePath}, ${row.traceKind}
      )`
        )
      )}
      ON CONFLICT ("messageId") DO NOTHING
      `;
}

function upsertRowsSql(batch: ArchivedTrajectoryRow[]): Prisma.Sql {
  return Prisma.sql`
      INSERT INTO "AgentTrajectorySearch" (
        "messageId", "userId", "rootAgentId", "agentId", surface, role,
        "createdAt", "searchText", "agentGoal", "agentTitle", "archivePath", "traceKind"
      ) VALUES ${Prisma.join(
        batch.map(
          (row) => Prisma.sql`(
        ${row.messageId}, ${row.userId}, ${row.rootAgentId}, ${row.agentId},
        ${row.surface}, ${row.role}, ${row.createdAt}, ${row.searchText},
        '', NULL, ${row.archivePath}, ${row.traceKind}
      )`
        )
      )}
      ON CONFLICT ("messageId") DO UPDATE SET
        "userId" = EXCLUDED."userId",
        "rootAgentId" = EXCLUDED."rootAgentId",
        "agentId" = EXCLUDED."agentId",
        surface = EXCLUDED.surface,
        role = EXCLUDED.role,
        "createdAt" = EXCLUDED."createdAt",
        "searchText" = EXCLUDED."searchText",
        "agentGoal" = EXCLUDED."agentGoal",
        "agentTitle" = EXCLUDED."agentTitle",
        "archivePath" = EXCLUDED."archivePath",
        "traceKind" = EXCLUDED."traceKind"
      WHERE "AgentTrajectorySearch"."userId" = EXCLUDED."userId"
        AND "AgentTrajectorySearch"."rootAgentId" = EXCLUDED."rootAgentId"
      `;
}

/**
 * The rows a finalize replaces for one bundle. code_event rows come from
 * code-session checkpoints, not this bundle; a finalize must not erase them.
 * No index leads with rootAgentId: the owner equality makes it a bounded seek
 * on AgentTrajectorySearch_user_root_time_idx instead of a whole-index walk.
 */
export function deleteArchivedBundleRowsSql(userId: string, rootAgentId: string): Prisma.Sql {
  return Prisma.sql`
    DELETE FROM "AgentTrajectorySearch"
    WHERE "userId" = ${userId}
      AND "rootAgentId" = ${rootAgentId}
      AND "archivePath" IS NOT NULL
      AND "traceKind" <> 'code_event'
  `;
}

async function replaceArchivedRows(
  userId: string,
  rootAgentId: string,
  rows: ArchivedTrajectoryRow[]
): Promise<void> {
  await runTransactionWithRetry(
    async (tx) => {
      await tx.$executeRaw(deleteArchivedBundleRowsSql(userId, rootAgentId));
      await writeTrajectoryRows(tx, rows, upsertRowsSql);
    },
    { timeout: 60_000 }
  );
}

/** Idempotent upsert of derived rows (e.g. code-session code_event rows). */
export async function upsertTrajectoryRows(rows: ArchivedTrajectoryRow[]): Promise<void> {
  await writeTrajectoryRows(prisma, rows, upsertRowsSql);
}

/** Index one finalized bundle. Grep then reads PostgreSQL, never scans R2. */
export async function indexArchivedTrace(
  rootAgentId: string,
  fixture: ScopedDbFixture,
  artifactPaths: string[],
  partialArchive = false
): Promise<number> {
  if (fixture.root_agent_id !== rootAgentId || !string(fixture.user_id)) {
    throw new Error(`Trace fixture owner/root mismatch for ${rootAgentId}`);
  }
  const rows = archivedMessageRows(fixture);
  // Replayed LLM inputs often repeat a stored message. Keep its original path
  // and timestamp instead of indexing later copies as separate search hits.
  const seen = new Set(
    rows.map((row) => contentDigest(rootAgentId, row.agentId, row.role, row.searchText))
  );
  const llmPaths = [...new Set(artifactPaths)]
    .filter((path) => /^(llm|llm-updates)\/.*\.json\.gz\.enc$/.test(path))
    .sort();
  const failures: Array<{ path: string; error: string }> = [];
  for (let start = 0; start < llmPaths.length; start += 4) {
    const paths = llmPaths.slice(start, start + 4);
    const results = await Promise.allSettled(paths.map((path) => readJson(rootAgentId, path)));
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        rows.push(...llmRows(fixture, paths[index], result.value, seen, partialArchive));
      } else {
        failures.push({
          path: paths[index],
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    });
  }
  if (failures.length > 0) {
    throw new Error(
      `Could not read ${failures.length} LLM artifacts for ${rootAgentId}: ${failures
        .slice(0, 3)
        .map((failure) => `${failure.path} (${failure.error})`)
        .join(', ')}`
    );
  }
  await replaceArchivedRows(fixture.user_id, rootAgentId, rows);
  return rows.length;
}

/** One-time and retry backfill for R2 bundles absent from the current DB. */
export async function indexArchivedTraceFromR2(
  rootAgentId: string,
  expectedUserId?: string
): Promise<number> {
  return withArchiveManifestLock(rootAgentId, () =>
    indexArchivedTraceFromR2Unlocked(rootAgentId, expectedUserId)
  );
}

/**
 * Index one llm/ artifact that arrived after finalization started. Only that
 * artifact is read and its rows are inserted alongside the finalized ones, so
 * N late files cost N reads rather than re-reading the whole run each time
 * (quadratic in file count). Content already indexed keeps its original path
 * and timestamp, exactly as the whole-bundle index orders it.
 */
export async function indexLateArchivedLlmArtifact(
  rootAgentId: string,
  objectPath: string
): Promise<number> {
  return withArchiveManifestLock(rootAgentId, async () => {
    const bundle = await loadIndexableBundle(rootAgentId);
    if (bundle === null) return 0;
    const { fixture, finalized } = bundle;
    const seen = new Set(
      archivedMessageRows(fixture).map((row) =>
        contentDigest(rootAgentId, row.agentId, row.role, row.searchText)
      )
    );
    const rows = llmRows(
      fixture,
      objectPath,
      await readJson(rootAgentId, objectPath),
      seen,
      !finalized
    );
    // A worker may rewrite the same path: replace that path's rows, never accumulate them.
    await runTransactionWithRetry(async (tx) => {
      await tx.$executeRaw`
        DELETE FROM "AgentTrajectorySearch"
        WHERE "userId" = ${fixture.user_id}
          AND "rootAgentId" = ${rootAgentId}
          AND "archivePath" = ${objectPath}
      `;
      await writeTrajectoryRows(tx, rows, insertRowsSql);
    });
    return rows.length;
  });
}

async function indexArchivedTraceFromR2Unlocked(
  rootAgentId: string,
  expectedUserId?: string
): Promise<number> {
  const bundle = await loadIndexableBundle(rootAgentId, expectedUserId);
  if (bundle === null) return 0;
  const objects = await listArchivedObjectsStrict(rootAgentId);
  return indexArchivedTrace(
    rootAgentId,
    bundle.fixture,
    objects.map((object) => object.path),
    !bundle.finalized
  );
}

/** The verified fixture a bundle is indexed from, or null when it must not be indexed yet. */
async function loadIndexableBundle(
  rootAgentId: string,
  expectedUserId?: string
): Promise<{ fixture: ScopedDbFixture; finalized: boolean } | null> {
  const manifest = record(await readJson(rootAgentId, 'manifest.json.gz.enc'));
  const correlations = record(manifest?.correlations);
  if (expectedUserId !== undefined && correlations?.user_id !== expectedUserId) return null;
  const archiveUserId = string(correlations?.user_id);
  if (archiveUserId === null) {
    throw new Error(`Trace archive has no owner for ${rootAgentId}`);
  }
  const owner = await prisma.user.findUnique({
    where: { userId: archiveUserId },
    select: { userId: true },
  });
  if (owner === null) return null;
  const finalized = manifest?.finalized === true;
  const fixture = (await readJson(
    rootAgentId,
    finalized ? END_FIXTURE_PATH : 'db/start.fixture.json.gz.enc'
  )) as ScopedDbFixture;
  if (
    manifest?.root_agent_id !== rootAgentId ||
    correlations?.user_id !== fixture.user_id ||
    correlations.root_agent_id !== rootAgentId ||
    fixture.root_agent_id !== rootAgentId
  ) {
    throw new Error(`Trace archive ownership/finalization check failed for ${rootAgentId}`);
  }
  if (!finalized) {
    const liveRoot = await prisma.agent.findUnique({
      where: { id: rootAgentId },
      select: { status: true },
    });
    if (liveRoot !== null && ['STARTING_UP', 'ACTIVE', 'PAUSED'].includes(liveRoot.status)) {
      return null;
    }
  }
  return { fixture, finalized };
}

export interface LiveMessageBackfillBatch {
  /** Highest Message.id scanned; pass it back as `afterId` for the next batch. */
  lastMessageId: string | null;
  scanned: number;
  inserted: number;
}

/**
 * Index one bounded, id-ordered batch of live SQL messages that predate the
 * projection triggers. Each call scans at most `limit` messages through the
 * primary key, so every statement stays far inside the pooler's statement
 * timeout regardless of total message volume. Rows mirror the
 * `sync_agent_trajectory_search` trigger; existing rows are left untouched.
 */
export async function backfillLiveMessageSearchBatch(
  afterId: string | null,
  limit: number
): Promise<LiveMessageBackfillBatch> {
  const batch = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT m.id FROM "Message" m
    WHERE ${afterId === null ? Prisma.sql`TRUE` : Prisma.sql`m.id > ${afterId}`}
    ORDER BY m.id
    LIMIT ${limit}
  `);
  if (batch.length === 0) return { lastMessageId: afterId, scanned: 0, inserted: 0 };
  const lastMessageId = batch[batch.length - 1].id;
  const inserted = await prisma.$executeRaw(Prisma.sql`
    WITH RECURSIVE batch AS (
      SELECT m.id, m."agentId", m.role, m."createdAt", m.text
      FROM "Message" m
      WHERE ${afterId === null ? Prisma.sql`TRUE` : Prisma.sql`m.id > ${afterId}`}
        AND m.id <= ${lastMessageId}
    ),
    lineage AS (
      SELECT a.id AS agent_id, a.id, a."parentAgentId", ARRAY[a.id] AS visited, 0 AS depth
      FROM "Agent" a
      WHERE a.id IN (SELECT DISTINCT "agentId" FROM batch)
      UNION ALL
      SELECT lineage.agent_id, parent.id, parent."parentAgentId",
             lineage.visited || parent.id, lineage.depth + 1
      FROM lineage
      JOIN "Agent" parent ON parent.id = lineage."parentAgentId"
      WHERE NOT parent.id = ANY(lineage.visited)
    ),
    roots AS (
      SELECT DISTINCT ON (agent_id) agent_id, id AS root_id
      FROM lineage
      ORDER BY agent_id, depth DESC
    )
    INSERT INTO "AgentTrajectorySearch" (
      "messageId", "userId", "rootAgentId", "agentId", "surface", "role", "createdAt",
      "searchText", "agentGoal", "agentTitle"
    )
    SELECT b.id, root."userId", roots.root_id, a.id, a.source::text, b.role::text,
           b."createdAt", b.text, '', NULL
    FROM batch b
    JOIN "Agent" a ON a.id = b."agentId"
    JOIN roots ON roots.agent_id = a.id
    JOIN "Agent" root ON root.id = roots.root_id
    WHERE btrim(b.text) <> '' AND b.role::text <> 'SYSTEM' AND root."userId" IS NOT NULL
    ON CONFLICT ("messageId") DO NOTHING
  `);
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "AgentTrajectoryAgent" ("agentId", "userId", "agentGoal", "agentTitle")
    SELECT DISTINCT ON (s."agentId") s."agentId", s."userId", a.goal, a.title
    FROM "AgentTrajectorySearch" s
    JOIN "Agent" a ON a.id = s."agentId"
    WHERE ${afterId === null ? Prisma.sql`TRUE` : Prisma.sql`s."messageId" > ${afterId}`}
      AND s."messageId" <= ${lastMessageId}
    ON CONFLICT ("agentId") DO NOTHING
  `);
  return { lastMessageId, scanned: batch.length, inserted };
}

export interface TrajectoryGoalBatch {
  /** Highest AgentTrajectorySearch.messageId scanned; pass back as `afterId`. */
  lastMessageId: string | null;
  scanned: number;
  /**
   * Agent rows created. A dry run commits nothing, so an agent whose copies span
   * batches is counted in each: dry-run totals are per-batch upper bounds.
   */
  inserted: number;
  /** Row copies cleared (dry run: a per-batch upper bound, as for `inserted`). */
  cleared: number;
  /**
   * Exact rows whose copy was cleared, with the value each copy held, for the
   * operator's receipt (empty on dry run).
   */
  clearedRows: Array<{
    messageId: string;
    agentId: string;
    agentGoal: string;
    agentTitle: string | null;
  }>;
}

/**
 * Per-statement bounds for the prod backfill: a batch that cannot get its row
 * locks quickly (a live trigger upsert holds them) fails fast and is retried
 * by the operator from its cursor instead of queueing behind live traffic.
 */
const GOAL_BATCH_STATEMENT_TIMEOUT = '15s';
const GOAL_BATCH_LOCK_TIMEOUT = '2s';

/**
 * Move legacy per-row goal/title copies onto AgentTrajectoryAgent in one
 * bounded, primary-key-ordered batch. Idempotent and resumable: an agent row
 * that already exists is kept (live writers hold the newest value), and a
 * row's copy is cleared only when its owner's agent row holds the same value.
 * `dryRun` counts the same inserts and clears inside a read-only transaction.
 */
export async function normalizeTrajectoryGoalBatch(
  afterId: string | null,
  limit: number,
  options: { dryRun?: boolean } = {}
): Promise<TrajectoryGoalBatch> {
  const after = afterId === null ? Prisma.sql`TRUE` : Prisma.sql`"messageId" > ${afterId}`;
  const scannedIds = await prisma.$queryRaw<Array<{ messageId: string }>>(Prisma.sql`
    SELECT "messageId" FROM "AgentTrajectorySearch" WHERE ${after}
    ORDER BY "messageId" LIMIT ${limit}
  `);
  if (scannedIds.length === 0)
    return { lastMessageId: afterId, scanned: 0, inserted: 0, cleared: 0, clearedRows: [] };
  const lastMessageId = scannedIds[scannedIds.length - 1].messageId;
  const sAfter = afterId === null ? Prisma.sql`TRUE` : Prisma.sql`s."messageId" > ${afterId}`;
  // The newest copy per agent in this batch: what the insert below would store.
  const candidates = Prisma.sql`
    SELECT DISTINCT ON ("agentId") "agentId", "userId", "agentGoal", "agentTitle"
    FROM "AgentTrajectorySearch"
    WHERE ${after} AND "messageId" <= ${lastMessageId}
      AND ("agentGoal" <> '' OR "agentTitle" IS NOT NULL)
    ORDER BY "agentId", "createdAt" DESC, "messageId" DESC
  `;
  const result = await runTransactionWithRetry(
    async (tx) => {
      // SET TRANSACTION must precede every other statement in the transaction.
      if (options.dryRun) await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = '${GOAL_BATCH_STATEMENT_TIMEOUT}'`);
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${GOAL_BATCH_LOCK_TIMEOUT}'`);
      if (options.dryRun) {
        const [counts] = await tx.$queryRaw<Array<{ inserted: bigint; cleared: bigint }>>(
          Prisma.sql`
          WITH c AS (${candidates}),
          target AS (
            SELECT c."agentId", c."userId", c."agentGoal", c."agentTitle", FALSE AS existing
            FROM c WHERE NOT EXISTS (
              SELECT 1 FROM "AgentTrajectoryAgent" g WHERE g."agentId" = c."agentId")
            UNION ALL
            SELECT g."agentId", g."userId", g."agentGoal", g."agentTitle", TRUE
            FROM "AgentTrajectoryAgent" g WHERE g."agentId" IN (SELECT "agentId" FROM c)
          )
          SELECT
            (SELECT count(*) FROM target WHERE NOT existing) AS inserted,
            (SELECT count(*) FROM "AgentTrajectorySearch" s JOIN target t
               ON t."agentId" = s."agentId" AND t."userId" = s."userId"
             WHERE ${sAfter} AND s."messageId" <= ${lastMessageId}
               AND (s."agentGoal" <> '' OR s."agentTitle" IS NOT NULL)
               AND t."agentGoal" = s."agentGoal"
               AND t."agentTitle" IS NOT DISTINCT FROM s."agentTitle") AS cleared
        `
        );
        return {
          inserted: Number(counts.inserted),
          cleared: Number(counts.cleared),
          clearedRows: [] as TrajectoryGoalBatch['clearedRows'],
        };
      }
      const inserted = await tx.$executeRaw(Prisma.sql`
      INSERT INTO "AgentTrajectoryAgent" ("agentId", "userId", "agentGoal", "agentTitle")
      ${candidates}
      ON CONFLICT ("agentId") DO NOTHING
    `);
      const clearedRows = await tx.$queryRaw<TrajectoryGoalBatch['clearedRows']>(
        Prisma.sql`
        UPDATE "AgentTrajectorySearch" s SET "agentGoal" = '', "agentTitle" = NULL
        FROM "AgentTrajectoryAgent" g
        WHERE ${sAfter}
          AND s."messageId" <= ${lastMessageId}
          AND (s."agentGoal" <> '' OR s."agentTitle" IS NOT NULL)
          AND g."agentId" = s."agentId" AND g."userId" = s."userId"
          -- Only an identical copy is redundant; a divergent legacy copy stays,
          -- so normalization never changes what search returns.
          AND g."agentGoal" = s."agentGoal"
          AND g."agentTitle" IS NOT DISTINCT FROM s."agentTitle"
        RETURNING s."messageId", s."agentId", g."agentGoal", g."agentTitle"
      `
      );
      return { inserted, cleared: clearedRows.length, clearedRows };
      // Above the statements' own 15s limits, so those, not Prisma, bound the batch.
    },
    { timeout: 40_000 }
  );
  return { lastMessageId, scanned: scannedIds.length, ...result };
}
