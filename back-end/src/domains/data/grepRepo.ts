/**
 * Data domain repo — raw SQL for the unified regex Grep across messages and
 * contacts. Uses Postgres `~`/`~*` (regex) via $queryRaw. The other families
 * live beside this file and are re-exported, so callers import one module.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import { messageAccessPredicate, type MessageAccess } from './teamAccessRepo';
import { pageSize, regexPredicate } from './sharedGrepRepo';

export * from './agentNetworkGrepRepo';
export * from './documentGrepRepo';
export * from './transactionGrepRepo';

export interface MessageGrepRow {
  userId: string;
  googleAccountEmail: string | null;
  id: string;
  personId: string;
  channel: string;
  from: string;
  to: string;
  timestamp: Date;
  message: string;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null;
  email: string | null;
}

export interface NetworkGrepRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  phoneNumber: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  relation: string | null;
  communicationFrequency: string | null;
  messagesExchanged: number | null;
  createdAt: Date;
}

/**
 * Resolve a person identifier (UUID, email, phone, or name) to a person ID for
 * the messages-only `person` filter. Returns null if no match.
 */
export async function resolvePersonId(userId: string, identifier: string): Promise<string | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);
  if (isUuid) {
    const byId = await prisma.person.findFirst({
      where: { id: identifier, userId },
      select: { id: true },
    });
    return byId?.id ?? null;
  }
  const [first, ...rest] = identifier.split(' ');
  const person = await prisma.person.findFirst({
    where: {
      userId,
      OR: [
        { email: { equals: identifier, mode: 'insensitive' } },
        { phoneNumber: identifier },
        { firstName: { equals: identifier, mode: 'insensitive' } },
        ...(rest.length > 0
          ? [
              {
                AND: [
                  { firstName: { equals: first, mode: 'insensitive' as const } },
                  { lastName: { equals: rest.join(' '), mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ],
    },
    select: { id: true },
  });
  return person?.id ?? null;
}

/**
 * Optional messages narrowing: scope to one contact, a time cutoff, and/or a
 * single channel. `channel` is only set by the fine-grained channel sources
 * (email/imessage/whatsapp); when undefined the emitted SQL is byte-
 * identical to the pre-channel query used by messages/gmail.
 */
function messageFilters(
  personId: string | undefined,
  since: Date | undefined,
  channel: string | undefined,
  messageId?: string,
  personIds?: string[]
): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (personIds !== undefined)
    parts.push(
      personIds.length
        ? Prisma.sql`AND m."personId" IN (${Prisma.join(personIds)})`
        : Prisma.sql`AND FALSE`
    );
  if (personId !== undefined) parts.push(Prisma.sql`AND m."personId" = ${personId}`);
  if (since !== undefined) parts.push(Prisma.sql`AND m.timestamp >= ${since}`);
  if (channel !== undefined) parts.push(Prisma.sql`AND m.channel::text = ${channel}`);
  // Set when `filters.path` addresses one message (`messages/<thread>/<id>`)
  // rather than the whole thread.
  if (messageId !== undefined) parts.push(Prisma.sql`AND m.id = ${messageId}`);
  return parts.length > 0 ? Prisma.join(parts, ' ') : Prisma.empty;
}

export async function countMessageGrepRows(params: {
  userId: string;
  access: MessageAccess;
  personIds?: string[];
  pattern: string;
  caseInsensitive: boolean;
  personId?: string;
  messageId?: string;
  since?: Date;
  channel?: string;
}): Promise<number> {
  const predicate = regexPredicate(Prisma.sql`m.message`, params.pattern, params.caseInsensitive);
  const filters = messageFilters(
    params.personId,
    params.since,
    params.channel,
    params.messageId,
    params.personIds
  );
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "MessageRecord" m
    WHERE ${messageAccessPredicate(params.access)}
      AND ${predicate}
      ${filters}
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function countNetworkGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  personId?: string;
}): Promise<number> {
  const expression = Prisma.sql`(
    COALESCE(p."firstName", '') || E'\n' ||
    COALESCE(p."lastName", '') || E'\n' ||
    COALESCE(p.email, '') || E'\n' ||
    COALESCE(p."phoneNumber", '') || E'\n' ||
    COALESCE(p.company, '') || E'\n' ||
    COALESCE(p.title, '') || E'\n' ||
    COALESCE(p.relation, '') || E'\n' ||
    COALESCE(p."communicationFrequency", '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "Person" p
    WHERE p."userId" = ${params.userId}
      AND ${predicate}
      ${params.personId !== undefined ? Prisma.sql`AND p.id = ${params.personId}` : Prisma.empty}
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function searchNetworkGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  limit: number;
  offset: number;
  personId?: string;
}): Promise<NetworkGrepRow[]> {
  const expression = Prisma.sql`(
    COALESCE(p."firstName", '') || E'\n' ||
    COALESCE(p."lastName", '') || E'\n' ||
    COALESCE(p.email, '') || E'\n' ||
    COALESCE(p."phoneNumber", '') || E'\n' ||
    COALESCE(p.company, '') || E'\n' ||
    COALESCE(p.title, '') || E'\n' ||
    COALESCE(p.relation, '') || E'\n' ||
    COALESCE(p."communicationFrequency", '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  return prisma.$queryRaw<NetworkGrepRow[]>`
    SELECT
      p.id,
      p."firstName",
      p."lastName",
      p."phoneNumber",
      p.email,
      p.company,
      p.title,
      p.relation,
      p."communicationFrequency",
      p."messagesExchanged",
      p."createdAt"
    FROM "Person" p
    WHERE p."userId" = ${params.userId}
      AND ${predicate}
      ${params.personId !== undefined ? Prisma.sql`AND p.id = ${params.personId}` : Prisma.empty}
    ORDER BY p."messagesExchanged" DESC, p."lastName" ASC, p.id ASC
    LIMIT ${pageSize(params.limit, params.offset)}
  `;
}

/** Resolve a shared contact only if an authorized message identifies it. */
export async function resolveMessagePersonIds(
  access: MessageAccess,
  identifier: string
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT DISTINCT p.id FROM "Person" p JOIN "MessageRecord" m ON m."personId" = p.id
    WHERE ${messageAccessPredicate(access)} AND (
      p.id = ${identifier} OR lower(p.email) = lower(${identifier}) OR p."phoneNumber" = ${identifier}
      OR lower(p."firstName") = lower(${identifier})
      OR lower(concat_ws(' ', p."firstName", p."lastName")) = lower(${identifier})
    ) ORDER BY p.id
  `;
  return rows.map((row) => row.id);
}
