import { Prisma } from '@prisma/client';

import { prisma } from '../../providers/database';
import type { MessageGrepRow } from './grepRepo';
import { messageAccessPredicate, type MessageAccess } from './teamAccessRepo';
import { regexPredicate } from './sharedGrepRepo';

export interface MessageContextRow extends MessageGrepRow {
  anchorId: string;
}

/** Select message matches in the same oldest-first order returned to callers. */
export async function searchConversationMatchRows(params: {
  userId: string;
  access: MessageAccess;
  pattern: string;
  caseInsensitive: boolean;
  limit: number;
  offset: number;
  personId?: string;
  personIds?: string[];
  /** Set when `filters.path` addresses one message rather than a whole thread. */
  messageId?: string;
  since?: Date;
  channel?: string;
}): Promise<MessageGrepRow[]> {
  const predicate = regexPredicate(Prisma.sql`m.message`, params.pattern, params.caseInsensitive);
  const personFilter =
    params.personId === undefined
      ? Prisma.empty
      : Prisma.sql`AND m."personId" = ${params.personId}`;
  const peopleFilter =
    params.personIds === undefined
      ? Prisma.empty
      : params.personIds.length
        ? Prisma.sql`AND m."personId" IN (${Prisma.join(params.personIds)})`
        : Prisma.sql`AND FALSE`;
  const sinceFilter =
    params.since === undefined ? Prisma.empty : Prisma.sql`AND m.timestamp >= ${params.since}`;
  const channelFilter =
    params.channel === undefined
      ? Prisma.empty
      : Prisma.sql`AND m.channel::text = ${params.channel}`;
  const messageFilter =
    params.messageId === undefined ? Prisma.empty : Prisma.sql`AND m.id = ${params.messageId}`;

  return prisma.$queryRaw<MessageGrepRow[]>`
    SELECT
      m.id,
      m."userId",
      m."googleAccountEmail",
      m."personId",
      m.channel::text AS channel,
      m."from",
      m."to",
      m.timestamp,
      m.message,
      p."firstName",
      p."lastName",
      p."phoneNumber",
      p.email
    FROM "MessageRecord" m
    INNER JOIN "Person" p ON p.id = m."personId"
    WHERE ${messageAccessPredicate(params.access)}
      AND ${predicate}
      ${messageFilter}
      ${personFilter}
      ${peopleFilter}
      ${sinceFilter}
      ${channelFilter}
    ORDER BY m.timestamp ASC, m.id ASC
    LIMIT ${Math.max(1, params.limit + params.offset)}
  `;
}

/** Fetch adjacent message records for every matched anchor in one query. */
export async function findMessageContextRows(params: {
  userId: string;
  access: MessageAccess;
  anchorIds: string[];
  before: number;
  after: number;
  since?: Date;
  channel?: string;
}): Promise<MessageContextRow[]> {
  if (params.anchorIds.length === 0) return [];
  const sinceFilter =
    params.since === undefined ? Prisma.empty : Prisma.sql`AND m.timestamp >= ${params.since}`;
  const channelFilter =
    params.channel === undefined
      ? Prisma.empty
      : Prisma.sql`AND m.channel::text = ${params.channel}`;

  return prisma.$queryRaw<MessageContextRow[]>`
    WITH anchors AS (
      SELECT m.*
      FROM "MessageRecord" m
      WHERE ${messageAccessPredicate(params.access)}
        AND m.id IN (${Prisma.join(params.anchorIds)})
    )
    SELECT
      a.id AS "anchorId",
      c.id,
      c."userId",
      c."googleAccountEmail",
      c."personId",
      c.channel::text AS channel,
      c."from",
      c."to",
      c.timestamp,
      c.message,
      p."firstName",
      p."lastName",
      p."phoneNumber",
      p.email
    FROM anchors a
    CROSS JOIN LATERAL (
      (
        SELECT m.*
        FROM "MessageRecord" m
        WHERE m."personId" = a."personId"
          AND ${messageAccessPredicate(params.access)}
          AND (m.timestamp, m.id) < (a.timestamp, a.id)
          ${sinceFilter}
          ${channelFilter}
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT ${params.before}
      )
      UNION ALL
      SELECT a.*
      UNION ALL
      (
        SELECT m.*
        FROM "MessageRecord" m
        WHERE m."personId" = a."personId"
          AND ${messageAccessPredicate(params.access)}
          AND (m.timestamp, m.id) > (a.timestamp, a.id)
          ${sinceFilter}
          ${channelFilter}
        ORDER BY m.timestamp ASC, m.id ASC
        LIMIT ${params.after}
      )
    ) c
    INNER JOIN "Person" p ON p.id = c."personId"
    ORDER BY a.timestamp DESC, a.id DESC, c.timestamp ASC, c.id ASC
  `;
}
