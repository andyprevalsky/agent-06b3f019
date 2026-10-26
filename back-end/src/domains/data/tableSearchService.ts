/**
 * Data domain: grep over the transactions, documents and current-agent-tree
 * tables. Split out of service.ts so each function stays within the
 * per-function line limit.
 */

import { AgentNotFoundError, MissingAgentIdError } from './errors';
import { buildAgentNetworkMatch, buildDocumentMatch, buildTransactionMatch } from './format';
import * as grepRepo from './grepRepo';
import * as repo from './repo';
import type { GrepMatch, GrepResult, ValidatedGrepInput } from './types';

interface SourceSearchResult {
  total: number;
  matches: GrepMatch[];
}

function transactionQuery(userId: string, input: ValidatedGrepInput) {
  const filters = input.filters.transactions;
  return {
    userId,
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
  input: ValidatedGrepInput
): Promise<SourceSearchResult> {
  const filters = input.filters.transactions;
  const query = {
    ...transactionQuery(userId, input),
    pathInstitution: filters?.pathInstitution,
    pathAccount: filters?.pathAccount,
    pathTransactionId: filters?.pathTransactionId,
  };
  const [total, rows] = await Promise.all([
    grepRepo.countTransactionGrepRows(query),
    grepRepo.searchTransactionGrepRows({ ...query, limit: input.headLimit, offset: input.offset }),
  ]);
  return { total, matches: rows.map((row) => buildTransactionMatch(row, input)) };
}

/** Currency totals for a transactions grep, over every matching row. */
export async function transactionSummaries(
  userId: string,
  input: ValidatedGrepInput
): Promise<NonNullable<GrepResult['summaries']>['transactions']> {
  const filters = input.filters.transactions;
  const aggregateRows = await grepRepo.aggregateTransactionGrepRows({
    ...transactionQuery(userId, input),
    includePendingInTotals: filters?.includePendingInTotals,
  });
  return {
    totals_include_pending: filters?.includePendingInTotals === true,
    currencies: aggregateRows.map((row) => ({
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
  input: ValidatedGrepInput
): Promise<SourceSearchResult> {
  const filters = input.filters.documents;
  const query = {
    userId,
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
  return { total, matches: rows.map((row) => buildDocumentMatch(row, input)) };
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
