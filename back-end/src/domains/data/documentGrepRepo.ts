/**
 * Data domain repo: raw SQL for grep over imported documents (notes, chat
 * exports). Calendar and Drive share the table but have their own repo.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { GOOGLE_WORKSPACE_SOURCES } from '../../services/integrations/googleWorkspaceDocuments';
import { GRANOLA_PROVIDER, GRANOLA_SOURCES } from '../../services/integrations/granolaDocuments';
import { meetingSources } from '../../services/integrations/meetingDocuments';
import { pageSize, regexPredicate } from './sharedGrepRepo';

export interface DocumentGrepRow {
  id: string;
  source: string;
  externalId: string;
  title: string;
  content: string;
  url: string | null;
  metadata: Prisma.JsonValue | null;
  sourceUpdatedAt: Date | null;
  lastSeenAt: Date;
  deletedAt: Date | null;
  updatedAt: Date;
}

export interface DocumentSummaryResult {
  total_documents: number;
  sources: Record<string, number>;
  date_range: {
    from: string | null;
    to: string | null;
  };
}

/**
 * Calendar and Drive rows share this table but are their own grep sources, with
 * their own paths, event-time filters and refresh. The generic `documents`
 * source must not offer a second, stale way into them.
 */
const NOT_GOOGLE_WORKSPACE = Prisma.sql`d.source NOT IN (${Prisma.join([...GOOGLE_WORKSPACE_SOURCES])})`;

/**
 * Meeting providers store note, summary and transcript layers. Provider aliases
 * select their own layers; meeting_notes selects both providers. Concrete layer
 * names still select only that layer.
 */
// A Map, not an object: `document_source` is caller input, and names such as
// `constructor` or `__proto__` must never resolve to an inherited property.
const DOCUMENT_SOURCE_FAMILIES = new Map<string, readonly string[]>([
  [GRANOLA_PROVIDER, GRANOLA_SOURCES],
  ['fireflies', meetingSources('fireflies')],
  ['meeting_notes', [...GRANOLA_SOURCES, ...meetingSources('fireflies')]],
]);

function sourceIs(documentSource: string): Prisma.Sql {
  const family = DOCUMENT_SOURCE_FAMILIES.get(documentSource);
  return family === undefined
    ? Prisma.sql`d.source = ${documentSource}`
    : Prisma.sql`d.source IN (${Prisma.join([...family])})`;
}

function documentFilters(params: {
  documentSource?: string;
  since?: Date;
  until?: Date;
  path?: string;
  pathDocumentSource?: string;
  pathRest?: string;
  tag?: string;
}): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`d."deletedAt" IS NULL`, NOT_GOOGLE_WORKSPACE];
  if (params.documentSource !== undefined) {
    parts.push(sourceIs(params.documentSource));
  }
  // `filters.path` given as a path this tool printed: `documents/<source>/<rest>`.
  // The rest is the vault+relative path (obsidian) or title+externalId, so match
  // it against the same fields those segments were built from.
  if (params.pathDocumentSource !== undefined) {
    parts.push(sourceIs(params.pathDocumentSource));
  }
  if (params.pathRest !== undefined) {
    const tail = params.pathRest.split('/');
    const last = tail[tail.length - 1];
    parts.push(Prisma.sql`(
      d."externalId" = ${last}
      OR d.title = ${last}
      OR COALESCE(d.metadata::text, '') ILIKE ${`%${last}%`}
    )`);
  }
  if (params.since !== undefined) {
    parts.push(Prisma.sql`COALESCE(d."sourceUpdatedAt", d."updatedAt") >= ${params.since}`);
  }
  if (params.until !== undefined) {
    parts.push(Prisma.sql`COALESCE(d."sourceUpdatedAt", d."updatedAt") <= ${params.until}`);
  }
  if (params.path !== undefined) {
    const path = `%${params.path}%`;
    parts.push(Prisma.sql`(
      d."externalId" ILIKE ${path}
      OR d.title ILIKE ${path}
      OR COALESCE(d.url, '') ILIKE ${path}
      OR COALESCE(d.metadata::text, '') ILIKE ${path}
    )`);
  }
  if (params.tag !== undefined) {
    const tag = `%${params.tag}%`;
    parts.push(Prisma.sql`COALESCE(d.metadata::text, '') ILIKE ${tag}`);
  }
  return Prisma.sql`AND ${Prisma.join(parts, ' AND ')}`;
}

export async function countDocumentGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  documentSource?: string;
  since?: Date;
  until?: Date;
  path?: string;
  pathDocumentSource?: string;
  pathRest?: string;
  tag?: string;
}): Promise<number> {
  const expression = Prisma.sql`concat_ws(E'\n',
    d.title,
    d.content,
    COALESCE(d.url, ''),
    COALESCE(d.metadata::text, '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  const filters = documentFilters(params);
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "UserDataDocument" d
    WHERE d."userId" = ${params.userId}
      AND ${predicate}
      ${filters}
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function searchDocumentGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  limit: number;
  offset: number;
  documentSource?: string;
  since?: Date;
  until?: Date;
  path?: string;
  pathDocumentSource?: string;
  pathRest?: string;
  tag?: string;
}): Promise<DocumentGrepRow[]> {
  const expression = Prisma.sql`concat_ws(E'\n',
    d.title,
    d.content,
    COALESCE(d.url, ''),
    COALESCE(d.metadata::text, '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  const filters = documentFilters(params);
  return prisma.$queryRaw<DocumentGrepRow[]>`
    SELECT
      d.id,
      d.source,
      d."externalId",
      d.title,
      d.content,
      d.url,
      d.metadata,
      d."sourceUpdatedAt",
      d."lastSeenAt",
      d."deletedAt",
      d."updatedAt"
    FROM "UserDataDocument" d
    WHERE d."userId" = ${params.userId}
      AND ${predicate}
      ${filters}
    ORDER BY COALESCE(d."sourceUpdatedAt", d."updatedAt") DESC, d.id DESC
    LIMIT ${pageSize(params.limit, params.offset)}
  `;
}

export async function getDocumentSummary(userId: string): Promise<DocumentSummaryResult> {
  const rows = await prisma.$queryRaw<
    Array<{
      total_documents: bigint;
      from_date: Date | null;
      to_date: Date | null;
    }>
  >`
    SELECT
      COUNT(d.id)::bigint AS total_documents,
      MIN(COALESCE(d."sourceUpdatedAt", d."updatedAt")) AS from_date,
      MAX(COALESCE(d."sourceUpdatedAt", d."updatedAt")) AS to_date
    FROM "UserDataDocument" d
    WHERE d."userId" = ${userId}
      AND d."deletedAt" IS NULL
      AND ${NOT_GOOGLE_WORKSPACE}
  `;
  const sourceRows = await prisma.userDataDocument.groupBy({
    by: ['source'],
    where: { userId, deletedAt: null, source: { notIn: [...GOOGLE_WORKSPACE_SOURCES] } },
    _count: true,
  });
  const row = rows[0];
  return {
    total_documents: Number(row?.total_documents ?? 0),
    sources: Object.fromEntries(
      sourceRows.map((sourceRow) => [sourceRow.source, sourceRow._count])
    ),
    date_range: {
      from: row?.from_date?.toISOString() ?? null,
      to: row?.to_date?.toISOString() ?? null,
    },
  };
}
