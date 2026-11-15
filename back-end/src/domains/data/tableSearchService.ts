/**
 * Data domain: grep over the transactions, documents and current-agent-tree
 * tables. Split out of service.ts so each function stays within the
 * per-function line limit.
 */

import { AgentNotFoundError, MissingAgentIdError } from './errors';
import { buildAgentNetworkMatch, buildDocumentMatch, buildTransactionMatch } from './format';
import * as grepRepo from './grepRepo';
import * as repo from './repo';
import {
  documentAccess,
  documentAccessPredicate,
  documentOwnership,
  OUTSIDE_SCOPE_NOTICE,
  transactionAccess,
  transactionAccessPredicate,
  transactionOwnership,
  type TableAccess,
} from './tableAccessRepo';
import type { SharedGrant } from './teamAccessRepo';
import type { GrepMatch, GrepResult, ValidatedGrepInput } from './types';

interface SourceSearchResult {
  total: number;
  matches: GrepMatch[];
  notice?: string;
}

function transactionQuery(access: TableAccess, input: ValidatedGrepInput) {
  const filters = input.filters.transactions;
  return {
    access,
    pattern: input.dbPattern,
    caseInsensitive: input.caseInsensitive,
    since: filters?.since,
    until: filters?.until,
    account: filters?.account,
    minAmount: filters?.minAmount,
    maxAmount: filters?.maxAmount,
    status: filters?.status,
  };
}

export async function searchTransactionSource(
  userId: string,
  input: ValidatedGrepInput,
  grants: SharedGrant[]
): Promise<SourceSearchResult> {
  const access = transactionAccess(userId, input.teamScope, grants);
  const notice = access.notice ?? OUTSIDE_SCOPE_NOTICE('transactions');
  if (transactionAccessPredicate(access) === null) return { total: 0, matches: [], notice };
  const filters = input.filters.transactions;
  const query = {
    ...transactionQuery(access, input),
    pathInstitution: filters?.pathInstitution,
    pathAccount: filters?.pathAccount,
    pathTransactionId: filters?.pathTransactionId,
  };
  const [total, rows] = await Promise.all([
    grepRepo.countTransactionGrepRows(query),
    grepRepo.searchTransactionGrepRows({ ...query, limit: input.headLimit, offset: input.offset }),
  ]);
  return {
    total,
    matches: rows.map((row) => ({
      ...buildTransactionMatch(row, input),
      ownership: transactionOwnership(access, row),
    })),
    ...(access.notice === undefined ? {} : { notice: access.notice }),
  };
}

/**
 * Currency totals for a transactions grep, over every matching row. Totals never mix
 * owners: each row is one owner's total in one currency. Undefined when nothing is readable.
 */
export async function transactionSummaries(
  userId: string,
  input: ValidatedGrepInput,
  grants: SharedGrant[]
): Promise<NonNullable<GrepResult['summaries']>['transactions']> {
  const access = transactionAccess(userId, input.teamScope, grants);
  if (transactionAccessPredicate(access) === null) return undefined;
  const filters = input.filters.transactions;
  const aggregateRows = await grepRepo.aggregateTransactionGrepRows({
    ...transactionQuery(access, input),
    includePendingInTotals: filters?.includePendingInTotals,
  });
  return {
    totals_include_pending: filters?.includePendingInTotals === true,
    currencies: aggregateRows.map((row) => ({
      owner_user_id: row.userId,
      currency: row.currency,
      outflow: row.outflow?.toString() ?? '0',
      inflow: row.inflow?.toString() ?? '0',
      net: row.net?.toString() ?? '0',
      count: Number(row.count),
    })),
  };
}

export async function searchDocumentSource(
  userId: string,
  input: ValidatedGrepInput,
  grants: SharedGrant[]
): Promise<SourceSearchResult> {
  const access = documentAccess(userId, input.teamScope, grants);
  if (documentAccessPredicate(access) === null)
    return { total: 0, matches: [], notice: OUTSIDE_SCOPE_NOTICE('documents') };
  const filters = input.filters.documents;
  const query = {
    access,
    pattern: input.dbPattern,
    caseInsensitive: input.caseInsensitive,
    documentSource: filters?.documentSource,
    since: filters?.since,
    until: filters?.until,
    path: filters?.path,
    pathDocumentSource: filters?.pathDocumentSource,
    pathRest: filters?.pathRest,
    tag: filters?.tag,
  };
  const [total, rows] = await Promise.all([
    grepRepo.countDocumentGrepRows(query),
    grepRepo.searchDocumentGrepRows({ ...query, limit: input.headLimit, offset: input.offset }),
  ]);
  return {
    total,
    matches: rows.map((row) => ({
      ...buildDocumentMatch(row, input),
      ownership: documentOwnership(access, row),
    })),
  };
}

async function agentTreeIdsForGrep(userId: string, agentId: string | undefined): Promise<string[]> {
  if (agentId === undefined || agentId === '') throw new MissingAgentIdError();
  const agent = await repo.findAgentByIdAndUser(agentId, userId);
  if (agent === null) throw new AgentNotFoundError(agentId);
  const rootId = await repo.findRootAgentId(agentId, userId);
  return repo.findAgentTreeIds(rootId, userId);
}

export async function searchAgentNetworkSource(
  userId: string,
  input: ValidatedGrepInput,
  agentId: string | undefined
): Promise<SourceSearchResult> {
  const filters = input.filters.agentNetwork;
  const query = {
    agentIds: await agentTreeIdsForGrep(userId, agentId),
    pattern: input.dbPattern,
    caseInsensitive: input.caseInsensitive,
    pathAgentIds: filters?.pathAgentIds,
    pathAgentId: filters?.pathAgentId,
    pathRole: filters?.pathRole,
    pathMessageId: filters?.pathMessageId,
    role: filters?.role,
  };
  const [total, rows] = await Promise.all([
    grepRepo.countAgentNetworkGrepRows(query),
    grepRepo.searchAgentNetworkGrepRows({ ...query, limit: input.headLimit, offset: input.offset }),
  ]);
  return { total, matches: rows.map((row) => buildAgentNetworkMatch(row, input)) };
}
