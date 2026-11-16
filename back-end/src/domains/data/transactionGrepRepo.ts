/**
 * Data domain repo: raw SQL for grep over synced bank transactions.
 */

import { Prisma } from '@prisma/client';
import { parseAccountLabel } from './path';
import { prisma } from '../../providers/database';
import { pageSize, regexPredicate } from './sharedGrepRepo';
import { transactionAccessPredicate, type TableAccess } from './tableAccessRepo';

/** Every searchable transaction field, one per line. */
const TRANSACTION_TEXT = Prisma.sql`concat_ws(E'\n',
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

/** Own rows plus live Plaid item shares; nothing when the scope reads no transactions. */
function transactionScope(access: TableAccess): Prisma.Sql {
  return transactionAccessPredicate(access) ?? Prisma.sql`FALSE`;
}

export interface TransactionGrepRow {
  id: string;
  userId: string;
  plaidItemId: string;
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
  userId: string;
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

function transactionFilters(params: {
  since?: Date;
  until?: Date;
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: 'pending' | 'posted' | 'all';
  includePendingInTotals?: boolean;
  forTotals?: boolean;
  pathInstitution?: string;
  pathAccount?: string;
  pathTransactionId?: string;
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
    // Results print the account as `<name> ****<mask>`. Feeding that printed
    // label back matched neither `a.name` nor `a.mask` (each holds only one half)
    // and silently returned nothing, so decompose it and match both halves.
    // Any other value keeps the original free-text behavior.
    const { accountName, accountMask } = parseAccountLabel(params.account);
    if (accountMask !== undefined) {
      parts.push(
        Prisma.sql`(a.name ILIKE ${`%${accountName}%`} AND COALESCE(a.mask, '') = ${accountMask})`
      );
    } else {
      const account = `%${params.account}%`;
      parts.push(Prisma.sql`(
        a.name ILIKE ${account}
        OR COALESCE(a.mask, '') ILIKE ${account}
        OR COALESCE(i."institutionName", '') ILIKE ${account}
        OR t."plaidAccountExternalId" ILIKE ${account}
      )`);
    }
  }
  // `filters.path` components address an institution/account/transaction subtree.
  if (params.pathInstitution !== undefined)
    parts.push(
      Prisma.sql`COALESCE(i."institutionName", 'unknown-institution') = ${params.pathInstitution}`
    );
  if (params.pathAccount !== undefined) {
    const { accountName, accountMask } = parseAccountLabel(params.pathAccount);
    parts.push(
      accountMask === undefined
        ? Prisma.sql`a.name = ${accountName}`
        : Prisma.sql`(a.name = ${accountName} AND COALESCE(a.mask, '') = ${accountMask})`
    );
  }
  if (params.pathTransactionId !== undefined)
    parts.push(Prisma.sql`t."plaidTransactionId" = ${params.pathTransactionId}`);
  return Prisma.sql`AND ${Prisma.join(parts, ' AND ')}`;
}

export async function countTransactionGrepRows(params: {
  access: TableAccess;
  pattern: string;
  caseInsensitive: boolean;
  since?: Date;
  until?: Date;
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: 'pending' | 'posted' | 'all';
  pathInstitution?: string;
  pathAccount?: string;
  pathTransactionId?: string;
}): Promise<number> {
  const predicate = regexPredicate(TRANSACTION_TEXT, params.pattern, params.caseInsensitive);
  const filters = transactionFilters(params);
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "PlaidTransaction" t
    INNER JOIN "PlaidAccount" a ON a.id = t."plaidAccountId"
    INNER JOIN "PlaidItem" i ON i.id = t."plaidItemId"
    WHERE ${transactionScope(params.access)}
      AND ${predicate}
      ${filters}
  `;
  return Number(rows[0]?.count ?? 0);
}

export async function searchTransactionGrepRows(params: {
  access: TableAccess;
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
  pathInstitution?: string;
  pathAccount?: string;
  pathTransactionId?: string;
}): Promise<TransactionGrepRow[]> {
  const predicate = regexPredicate(TRANSACTION_TEXT, params.pattern, params.caseInsensitive);
  const filters = transactionFilters(params);
  return prisma.$queryRaw<TransactionGrepRow[]>`
    SELECT
      t.id,
      t."userId",
      t."plaidItemId",
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
    WHERE ${transactionScope(params.access)}
      AND ${predicate}
      ${filters}
    ORDER BY t.date DESC, t.id DESC
    LIMIT ${pageSize(params.limit, params.offset)}
  `;
}

export async function aggregateTransactionGrepRows(params: {
  access: TableAccess;
  pattern: string;
  caseInsensitive: boolean;
  since?: Date;
  until?: Date;
  account?: string;
  minAmount?: number;
  maxAmount?: number;
  status?: 'pending' | 'posted' | 'all';
  pathInstitution?: string;
  pathAccount?: string;
  pathTransactionId?: string;
  includePendingInTotals?: boolean;
}): Promise<TransactionAggregateRow[]> {
  const predicate = regexPredicate(TRANSACTION_TEXT, params.pattern, params.caseInsensitive);
  const filters = transactionFilters({ ...params, forTotals: true });
  return prisma.$queryRaw<TransactionAggregateRow[]>`
    SELECT
      t."userId",
      COALESCE(t."isoCurrencyCode", t."unofficialCurrencyCode", 'UNKNOWN') AS currency,
      SUM(CASE WHEN t.direction = 'OUTFLOW' THEN t."absoluteAmount" ELSE 0 END) AS outflow,
      SUM(CASE WHEN t.direction = 'INFLOW' THEN t."absoluteAmount" ELSE 0 END) AS inflow,
      SUM(CASE WHEN t.direction = 'INFLOW' THEN t."absoluteAmount" ELSE -t."absoluteAmount" END) AS net,
      COUNT(*)::bigint AS count
    FROM "PlaidTransaction" t
    INNER JOIN "PlaidAccount" a ON a.id = t."plaidAccountId"
    INNER JOIN "PlaidItem" i ON i.id = t."plaidItemId"
    WHERE ${transactionScope(params.access)}
      AND ${predicate}
      ${filters}
    GROUP BY t."userId", currency
    ORDER BY t."userId" ASC, currency ASC
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
