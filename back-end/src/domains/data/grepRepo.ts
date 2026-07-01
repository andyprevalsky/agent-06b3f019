/**
 * Data domain repo — raw SQL for the unified regex Grep across messages,
 * contacts, and the agent tree. Uses Postgres `~`/`~*` (regex) via $queryRaw.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

export interface MessageGrepRow {
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

export interface AgentMessageGrepRow {
  id: string;
  text: string;
  role: 'SYSTEM' | 'ASSISTANT' | 'USER' | 'TOOL';
  agentId: string;
  createdAt: Date;
  metadata: Prisma.JsonValue | null;
  filePointer: Prisma.JsonValue | null;
  agentGoal: string;
  agentDepth: number;
}

function regexPredicate(
  expression: Prisma.Sql,
  pattern: string,
  caseInsensitive: boolean
): Prisma.Sql {
  if (pattern.length === 0) {
    return Prisma.sql`TRUE`;
  }
  return caseInsensitive
    ? Prisma.sql`${expression} ~* ${pattern}`
    : Prisma.sql`${expression} ~ ${pattern}`;
}

function pageSize(limit: number, offset: number): number {
  return Math.max(1, limit + offset);
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

/** Optional messages-only narrowing: scope to one contact and/or a time cutoff. */
function messageFilters(personId: string | undefined, since: Date | undefined): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (personId !== undefined) parts.push(Prisma.sql`AND m."personId" = ${personId}`);
  if (since !== undefined) parts.push(Prisma.sql`AND m.timestamp >= ${since}`);
  return parts.length > 0 ? Prisma.join(parts, ' ') : Prisma.empty;
}

export async function countMessageGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  personId?: string;
  since?: Date;
}): Promise<number> {
  const predicate = regexPredicate(Prisma.sql`m.message`, params.pattern, params.caseInsensitive);
  const filters = messageFilters(params.personId, params.since);
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "MessageRecord" m
    INNER JOIN "Person" p ON p.id = m."personId"
    WHERE p."userId" = ${params.userId}
      AND ${predicate}
      ${filters}
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function searchMessageGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  limit: number;
  offset: number;
  personId?: string;
  since?: Date;
}): Promise<MessageGrepRow[]> {
  const predicate = regexPredicate(Prisma.sql`m.message`, params.pattern, params.caseInsensitive);
  const filters = messageFilters(params.personId, params.since);
  return prisma.$queryRaw<MessageGrepRow[]>`
    SELECT
      m.id,
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
    WHERE p."userId" = ${params.userId}
      AND ${predicate}
      ${filters}
    ORDER BY m.timestamp DESC, m.id DESC
    LIMIT ${pageSize(params.limit, params.offset)}
  `;
}

export async function countNetworkGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
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
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function searchNetworkGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  limit: number;
  offset: number;
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
    ORDER BY p."messagesExchanged" DESC, p."lastName" ASC, p.id ASC
    LIMIT ${pageSize(params.limit, params.offset)}
  `;
}

export async function countAgentNetworkGrepRows(params: {
  agentIds: string[];
  pattern: string;
  caseInsensitive: boolean;
}): Promise<number> {
  if (params.agentIds.length === 0) return 0;
  const expression = Prisma.sql`concat_ws(E'\n',
    m.text,
    COALESCE(m.metadata::text, ''),
    COALESCE(m."filePointer"::text, '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "Message" m
    WHERE m."agentId" IN (${Prisma.join(params.agentIds)})
      AND ${predicate}
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function searchAgentNetworkGrepRows(params: {
  agentIds: string[];
  pattern: string;
  caseInsensitive: boolean;
  limit: number;
  offset: number;
}): Promise<AgentMessageGrepRow[]> {
  if (params.agentIds.length === 0) return [];
  const expression = Prisma.sql`concat_ws(E'\n',
    m.text,
    COALESCE(m.metadata::text, ''),
    COALESCE(m."filePointer"::text, '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  return prisma.$queryRaw<AgentMessageGrepRow[]>`
    SELECT
      m.id,
      m.text,
      m.role::text AS role,
      m."agentId",
      m."createdAt",
      m.metadata,
      m."filePointer",
      a.goal AS "agentGoal",
      a.depth AS "agentDepth"
    FROM "Message" m
    INNER JOIN "Agent" a ON a.id = m."agentId"
    WHERE m."agentId" IN (${Prisma.join(params.agentIds)})
      AND ${predicate}
    ORDER BY m."createdAt" DESC, m.id DESC
    LIMIT ${pageSize(params.limit, params.offset)}
  `;
}
