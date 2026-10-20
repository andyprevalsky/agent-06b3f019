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
    dump.ts_ms ?? dump.ingested_ms ?? dump.created_at,
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
  const output = textParts(dump.output).join('\n').trim();
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
        ${row.agentGoal}, ${row.agentTitle}, ${row.archivePath}, ${row.traceKind}
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

async function replaceArchivedRows(
  rootAgentId: string,
  rows: ArchivedTrajectoryRow[]
): Promise<void> {
  await runTransactionWithRetry(
    async (tx) => {
      // code_event rows come from code-session checkpoints, not this bundle;
      // a finalize must not erase them.
      await tx.agentTrajectorySearch.deleteMany({
        where: { rootAgentId, archivePath: { not: null }, traceKind: { not: 'code_event' } },
      });
      for (let start = 0; start < rows.length; start += WRITE_BATCH_SIZE) {
        await tx.$executeRaw(upsertRowsSql(rows.slice(start, start + WRITE_BATCH_SIZE)));
      }
    },
    { timeout: 60_000 }
  );
}

/** Idempotent upsert of derived rows (e.g. code-session code_event rows). */
export async function upsertTrajectoryRows(rows: ArchivedTrajectoryRow[]): Promise<void> {
  for (let start = 0; start < rows.length; start += WRITE_BATCH_SIZE) {
    await prisma.$executeRaw(upsertRowsSql(rows.slice(start, start + WRITE_BATCH_SIZE)));
  }
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
  await replaceArchivedRows(rootAgentId, rows);
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

async function indexArchivedTraceFromR2Unlocked(
  rootAgentId: string,
  expectedUserId?: string
): Promise<number> {
  const manifest = record(await readJson(rootAgentId, 'manifest.json.gz.enc'));
  const correlations = record(manifest?.correlations);
  if (expectedUserId !== undefined && correlations?.user_id !== expectedUserId) return 0;
  const archiveUserId = string(correlations?.user_id);
  if (archiveUserId === null) {
    throw new Error(`Trace archive has no owner for ${rootAgentId}`);
  }
  const owner = await prisma.user.findUnique({
    where: { userId: archiveUserId },
    select: { userId: true },
  });
  if (owner === null) return 0;
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
      return 0;
    }
  }
  const objects = await listArchivedObjectsStrict(rootAgentId);
  return indexArchivedTrace(
    rootAgentId,
    fixture,
    objects.map((object) => object.path),
    !finalized
  );
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
           b."createdAt", b.text, a.goal, a.title
    FROM batch b
    JOIN "Agent" a ON a.id = b."agentId"
    JOIN roots ON roots.agent_id = a.id
    JOIN "Agent" root ON root.id = roots.root_id
    WHERE btrim(b.text) <> '' AND b.role::text <> 'SYSTEM' AND root."userId" IS NOT NULL
    ON CONFLICT ("messageId") DO NOTHING
  `);
  return { lastMessageId, scanned: batch.length, inserted };
}
