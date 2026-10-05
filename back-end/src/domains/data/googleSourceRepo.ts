/**
 * Data domain repo: grep over Google Calendar and Drive rows in the document
 * store. Kept apart from grepRepo.ts so each file stays within max-lines.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { GOOGLE_WORKSPACE_SOURCES } from '../../services/integrations/googleWorkspaceDocuments';
import type { GoogleGrepSource, GoogleSourceGrepFilters } from './types';

export interface GoogleSourceGrepRow {
  id: string;
  source: string;
  externalId: string;
  title: string;
  content: string;
  url: string | null;
  metadata: Prisma.JsonValue | null;
  sourceUpdatedAt: Date | null;
  updatedAt: Date;
}

export interface GoogleSourceQuery {
  userId: string;
  source: GoogleGrepSource;
  documentSource: string;
  pattern: string;
  caseInsensitive: boolean;
  filters: GoogleSourceGrepFilters;
}

/**
 * The text a pattern is matched against is the text a match displays (see
 * format.google.ts), plus the path. Searching less than is shown made a file
 * unfindable by the type or modified line printed right in its own listing.
 * `concat_ws` drops the lines whose value is NULL.
 */
const SEARCH_TEXT: Record<GoogleGrepSource, Prisma.Sql> = {
  calendar: Prisma.sql`concat_ws(E'\n',
    'title: ' || d.title,
    'url: ' || d.url,
    d.metadata->>'path',
    d.content)`,
  drive: Prisma.sql`concat_ws(E'\n',
    'title: ' || d.title,
    'type: ' || (d.metadata->>'mimeType'),
    'modified: ' || (d.metadata->>'modifiedTime'),
    'owner: ' || (d.metadata->>'owner'),
    'url: ' || d.url,
    d.metadata->>'path',
    d.content)`,
};

function likeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function regexPredicate(query: GoogleSourceQuery): Prisma.Sql {
  if (query.pattern.length === 0) return Prisma.sql`TRUE`;
  const text = SEARCH_TEXT[query.source];
  return query.caseInsensitive
    ? Prisma.sql`${text} ~* ${query.pattern}`
    : Prisma.sql`${text} ~ ${query.pattern}`;
}

function calendarTimeParts(filters: GoogleSourceGrepFilters): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  // An event is in range when it overlaps it: it ends after `since` and starts
  // before `until`. Date-only bounds compare with the event's own local dates.
  if (filters.sinceDate !== undefined) {
    parts.push(Prisma.sql`d.metadata->>'endDate' >= ${filters.sinceDate}`);
  } else if (filters.since !== undefined) {
    parts.push(Prisma.sql`(d.metadata->>'end')::timestamptz >= ${filters.since}`);
  }
  if (filters.untilDate !== undefined) {
    parts.push(Prisma.sql`d.metadata->>'startDate' <= ${filters.untilDate}`);
  } else if (filters.until !== undefined) {
    parts.push(Prisma.sql`(d.metadata->>'start')::timestamptz <= ${filters.until}`);
  }
  return parts;
}

function driveTimeParts(filters: GoogleSourceGrepFilters): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];
  if (filters.since !== undefined) {
    parts.push(Prisma.sql`d."sourceUpdatedAt" >= ${filters.since}`);
  }
  if (filters.until !== undefined) {
    parts.push(Prisma.sql`d."sourceUpdatedAt" <= ${filters.until}`);
  }
  return parts;
}

function whereClause(query: GoogleSourceQuery): Prisma.Sql {
  const { filters } = query;
  const parts: Prisma.Sql[] = [
    Prisma.sql`d."userId" = ${query.userId}`,
    Prisma.sql`d.source = ${query.documentSource}`,
    Prisma.sql`d."deletedAt" IS NULL`,
    regexPredicate(query),
    ...(query.source === 'calendar' ? calendarTimeParts(filters) : driveTimeParts(filters)),
  ];
  if (filters.pathPrefix !== undefined) {
    // A path addresses one record; a folder path addresses everything below
    // it, not the folder's own row.
    parts.push(Prisma.sql`(
      (d.metadata->>'path' = ${filters.pathPrefix} AND d.metadata->>'kind' IS DISTINCT FROM 'folder')
      OR d.metadata->>'path' LIKE ${`${likeLiteral(filters.pathPrefix)}/%`}
    )`);
  }
  return Prisma.join(parts, ' AND ');
}

export async function countGoogleSourceRows(query: GoogleSourceQuery): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "UserDataDocument" d
    WHERE ${whereClause(query)}
  `;
  return Number(rows[0]?.count ?? 0);
}

/** Calendar is chronological; Drive is most recently modified first. */
export async function searchGoogleSourceRows(
  query: GoogleSourceQuery,
  limit: number
): Promise<GoogleSourceGrepRow[]> {
  const order =
    query.source === 'calendar'
      ? Prisma.sql`(d.metadata->>'start')::timestamptz ASC, d.id ASC`
      : Prisma.sql`COALESCE(d."sourceUpdatedAt", d."updatedAt") DESC, d.id DESC`;
  return prisma.$queryRaw<GoogleSourceGrepRow[]>`
    SELECT
      d.id,
      d.source,
      d."externalId",
      d.title,
      d.content,
      d.url,
      d.metadata,
      d."sourceUpdatedAt",
      d."updatedAt"
    FROM "UserDataDocument" d
    WHERE ${whereClause(query)}
    ORDER BY ${order}
    LIMIT ${Math.max(1, limit)}
  `;
}

/** Drive files under a path whose text has not been loaded yet. */
export async function findDriveRowsWithoutText(
  userId: string,
  documentSource: string,
  pathPrefix: string,
  limit: number
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT d.id
    FROM "UserDataDocument" d
    WHERE d."userId" = ${userId}
      AND d.source = ${documentSource}
      AND d."deletedAt" IS NULL
      AND d.metadata->>'kind' = 'file'
      AND d.metadata->>'contentIndexed' = 'false'
      AND (
        d.metadata->>'path' = ${pathPrefix}
        OR d.metadata->>'path' LIKE ${`${likeLiteral(pathPrefix)}/%`}
      )
    ORDER BY COALESCE(d."sourceUpdatedAt", d."updatedAt") DESC
    LIMIT ${limit}
  `;
  return rows.map((row) => row.id);
}

/** Stored events and files (folders excluded) per Google document source. */
export async function countGoogleSourceDocuments(userId: string): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ source: string; count: bigint }>>`
    SELECT d.source, COUNT(*)::bigint AS count
    FROM "UserDataDocument" d
    WHERE d."userId" = ${userId}
      AND d.source IN (${Prisma.join([...GOOGLE_WORKSPACE_SOURCES])})
      AND d."deletedAt" IS NULL
      AND d.metadata->>'kind' IS DISTINCT FROM 'folder'
    GROUP BY d.source
  `;
  return Object.fromEntries(rows.map((row) => [row.source, Number(row.count)]));
}
