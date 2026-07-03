/* eslint-disable max-lines */
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

export interface TransactionGrepRow {
  id: string;
  plaidTransactionId: string;
  plaidAccountId: string;
  plaidAccountExternalId: string;
  accountName: string;
  accountMask: string | null;
  institutionName: string | null;
  date: Date;
  authorizedDate: Date | null;
  name: string;
  merchantName: string | null;
  originalDescription: string | null;
  amount: Prisma.Decimal;
  absoluteAmount: Prisma.Decimal;
  direction: 'OUTFLOW' | 'INFLOW';
  isoCurrencyCode: string | null;
  unofficialCurrencyCode: string | null;
  category: string[];
  personalFinanceCategory: string | null;
  personalFinanceDetailed: string | null;
  paymentChannel: string | null;
  locationSummary: string | null;
  pending: boolean;
}

export interface TransactionAggregateRow {
  currency: string;
  outflow: Prisma.Decimal | null;
  inflow: Prisma.Decimal | null;
  net: Prisma.Decimal | null;
  count: bigint;
}

export interface TransactionSummaryResult {
  total_transactions: number;
  account_count: number;
  institutions: string[];
  date_range: {
    from: string | null;
    to: string | null;
  };
}

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

function transactionFilters(params: {
  since?: Date;
  until?: Date;
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: 'pending' | 'posted' | 'all';
  includePendingInTotals?: boolean;
  forTotals?: boolean;
}): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`t."removedAt" IS NULL`];
  if (params.since !== undefined) parts.push(Prisma.sql`t.date >= ${params.since}`);
  if (params.until !== undefined) parts.push(Prisma.sql`t.date <= ${params.until}`);
  if (params.minAmount !== undefined)
    parts.push(Prisma.sql`t."absoluteAmount" >= ${new Prisma.Decimal(params.minAmount)}`);
  if (params.maxAmount !== undefined)
    parts.push(Prisma.sql`t."absoluteAmount" <= ${new Prisma.Decimal(params.maxAmount)}`);
  if (params.status === 'pending') parts.push(Prisma.sql`t.pending = true`);
  if (params.status === 'posted') parts.push(Prisma.sql`t.pending = false`);
  if (params.forTotals === true && params.includePendingInTotals !== true)
    parts.push(Prisma.sql`t.pending = false`);
  if (params.account !== undefined) {
    const account = `%${params.account}%`;
    parts.push(Prisma.sql`(
      a.name ILIKE ${account}
      OR COALESCE(a.mask, '') ILIKE ${account}
      OR COALESCE(i."institutionName", '') ILIKE ${account}
      OR t."plaidAccountExternalId" ILIKE ${account}
    )`);
  }
  return Prisma.sql`AND ${Prisma.join(parts, ' AND ')}`;
}

function documentFilters(params: {
  documentSource?: string;
  since?: Date;
  until?: Date;
  path?: string;
  tag?: string;
}): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`d."deletedAt" IS NULL`];
  if (params.documentSource !== undefined) {
    parts.push(Prisma.sql`d.source = ${params.documentSource}`);
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

export async function countTransactionGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  since?: Date;
  until?: Date;
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: 'pending' | 'posted' | 'all';
}): Promise<number> {
  const expression = Prisma.sql`concat_ws(E'\n',
    t.name,
    COALESCE(t."merchantName", ''),
    COALESCE(t."originalDescription", ''),
    COALESCE(array_to_string(t.category, ' > '), ''),
    COALESCE(t."personalFinanceCategory", ''),
    COALESCE(t."personalFinanceDetailed", ''),
    COALESCE(t."paymentChannel", ''),
    COALESCE(t."locationSummary", ''),
    COALESCE(a.name, ''),
    COALESCE(a.mask, ''),
    COALESCE(i."institutionName", '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  const filters = transactionFilters(params);
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "PlaidTransaction" t
    INNER JOIN "PlaidAccount" a ON a.id = t."plaidAccountId"
    INNER JOIN "PlaidItem" i ON i.id = t."plaidItemId"
    WHERE t."userId" = ${params.userId}
      AND ${predicate}
      ${filters}
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function countDocumentGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  documentSource?: string;
  since?: Date;
  until?: Date;
  path?: string;
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

export async function searchTransactionGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  limit: number;
  offset: number;
  since?: Date;
  until?: Date;
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: 'pending' | 'posted' | 'all';
}): Promise<TransactionGrepRow[]> {
  const expression = Prisma.sql`concat_ws(E'\n',
    t.name,
    COALESCE(t."merchantName", ''),
    COALESCE(t."originalDescription", ''),
    COALESCE(array_to_string(t.category, ' > '), ''),
    COALESCE(t."personalFinanceCategory", ''),
    COALESCE(t."personalFinanceDetailed", ''),
    COALESCE(t."paymentChannel", ''),
    COALESCE(t."locationSummary", ''),
    COALESCE(a.name, ''),
    COALESCE(a.mask, ''),
    COALESCE(i."institutionName", '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  const filters = transactionFilters(params);
  return prisma.$queryRaw<TransactionGrepRow[]>`
    SELECT
      t.id,
      t."plaidTransactionId",
      t."plaidAccountId",
      t."plaidAccountExternalId",
      a.name AS "accountName",
      a.mask AS "accountMask",
      i."institutionName",
      t.date,
      t."authorizedDate",
      t.name,
      t."merchantName",
      t."originalDescription",
      t.amount,
      t."absoluteAmount",
      t.direction::text AS direction,
      t."isoCurrencyCode",
      t."unofficialCurrencyCode",
      t.category,
      t."personalFinanceCategory",
      t."personalFinanceDetailed",
      t."paymentChannel",
      t."locationSummary",
      t.pending
    FROM "PlaidTransaction" t
    INNER JOIN "PlaidAccount" a ON a.id = t."plaidAccountId"
    INNER JOIN "PlaidItem" i ON i.id = t."plaidItemId"
    WHERE t."userId" = ${params.userId}
      AND ${predicate}
      ${filters}
    ORDER BY t.date DESC, t.id DESC
    LIMIT ${pageSize(params.limit, params.offset)}
  `;
}

export async function aggregateTransactionGrepRows(params: {
  userId: string;
  pattern: string;
  caseInsensitive: boolean;
  since?: Date;
  until?: Date;
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: 'pending' | 'posted' | 'all';
  includePendingInTotals?: boolean;
}): Promise<TransactionAggregateRow[]> {
  const expression = Prisma.sql`concat_ws(E'\n',
    t.name,
    COALESCE(t."merchantName", ''),
    COALESCE(t."originalDescription", ''),
    COALESCE(array_to_string(t.category, ' > '), ''),
    COALESCE(t."personalFinanceCategory", ''),
    COALESCE(t."personalFinanceDetailed", ''),
    COALESCE(t."paymentChannel", ''),
    COALESCE(t."locationSummary", ''),
    COALESCE(a.name, ''),
    COALESCE(a.mask, ''),
    COALESCE(i."institutionName", '')
  )`;
  const predicate = regexPredicate(expression, params.pattern, params.caseInsensitive);
  const filters = transactionFilters({ ...params, forTotals: true });
  return prisma.$queryRaw<TransactionAggregateRow[]>`
    SELECT
      COALESCE(t."isoCurrencyCode", t."unofficialCurrencyCode", 'UNKNOWN') AS currency,
      SUM(CASE WHEN t.direction = 'OUTFLOW' THEN t."absoluteAmount" ELSE 0 END) AS outflow,
      SUM(CASE WHEN t.direction = 'INFLOW' THEN t."absoluteAmount" ELSE 0 END) AS inflow,
      SUM(CASE WHEN t.direction = 'INFLOW' THEN t."absoluteAmount" ELSE -t."absoluteAmount" END) AS net,
      COUNT(*)::bigint AS count
    FROM "PlaidTransaction" t
    INNER JOIN "PlaidAccount" a ON a.id = t."plaidAccountId"
    INNER JOIN "PlaidItem" i ON i.id = t."plaidItemId"
    WHERE t."userId" = ${params.userId}
      AND ${predicate}
      ${filters}
    GROUP BY currency
    ORDER BY currency ASC
  `;
}

export async function getTransactionSummary(userId: string): Promise<TransactionSummaryResult> {
  const rows = await prisma.$queryRaw<
    Array<{
      total_transactions: bigint;
      account_count: bigint;
      institutions: string[] | null;
      from_date: Date | null;
      to_date: Date | null;
    }>
  >`
    SELECT
      COUNT(t.id)::bigint AS total_transactions,
      COUNT(DISTINCT t."plaidAccountId")::bigint AS account_count,
      array_remove(array_agg(DISTINCT i."institutionName"), NULL) AS institutions,
      MIN(t.date) AS from_date,
      MAX(t.date) AS to_date
    FROM "PlaidTransaction" t
    INNER JOIN "PlaidItem" i ON i.id = t."plaidItemId"
    WHERE t."userId" = ${userId}
      AND t."removedAt" IS NULL
  `;
  const row = rows[0];
  return {
    total_transactions: Number(row?.total_transactions ?? 0),
    account_count: Number(row?.account_count ?? 0),
    institutions: row?.institutions ?? [],
    date_range: {
      from: row?.from_date?.toISOString() ?? null,
      to: row?.to_date?.toISOString() ?? null,
    },
  };
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
      COUNT(id)::bigint AS total_documents,
      MIN(COALESCE("sourceUpdatedAt", "updatedAt")) AS from_date,
      MAX(COALESCE("sourceUpdatedAt", "updatedAt")) AS to_date
    FROM "UserDataDocument"
    WHERE "userId" = ${userId}
      AND "deletedAt" IS NULL
  `;
  const sourceRows = await prisma.userDataDocument.groupBy({
    by: ['source'],
    where: { userId, deletedAt: null },
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
