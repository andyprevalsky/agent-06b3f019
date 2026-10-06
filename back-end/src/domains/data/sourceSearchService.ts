import { buildAgentNetworkMatch, buildDocumentMatch, buildTransactionMatch } from './format';
import {
  isMessageFamilySource,
  type GrepMatch,
  type ValidSource,
  type ValidatedGrepInput,
} from './types';
import { AgentNotFoundError, MissingAgentIdError } from './errors';
import * as repo from './repo';
import * as grepRepo from './grepRepo';
import { searchTrajectorySource } from './trajectorySearchService';
import { searchMessageSource } from './messageSearchService';
import { searchNetworkSource } from './networkSearchService';

interface SourceGrepResult {
  total: number;
  matches: GrepMatch[];
  hasMore?: boolean;
  nextPageAfter?: string | null;
}

async function searchTransactions(
  userId: string,
  input: ValidatedGrepInput
): Promise<SourceGrepResult> {
  const filters = input.filters.transactions;
  const [total, rows] = await Promise.all([
    grepRepo.countTransactionGrepRows({
      userId,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      since: filters?.since,
      until: filters?.until,
      account: filters?.account,
      minAmount: filters?.minAmount,
      maxAmount: filters?.maxAmount,
      status: filters?.status,
      pathInstitution: filters?.pathInstitution,
      pathAccount: filters?.pathAccount,
      pathTransactionId: filters?.pathTransactionId,
    }),
    grepRepo.searchTransactionGrepRows({
      userId,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      limit: input.headLimit,
      offset: input.offset,
      since: filters?.since,
      until: filters?.until,
      account: filters?.account,
      minAmount: filters?.minAmount,
      maxAmount: filters?.maxAmount,
      status: filters?.status,
      pathInstitution: filters?.pathInstitution,
      pathAccount: filters?.pathAccount,
      pathTransactionId: filters?.pathTransactionId,
    }),
  ]);
  return { total, matches: rows.map((row) => buildTransactionMatch(row, input)) };
}

async function searchDocuments(
  userId: string,
  input: ValidatedGrepInput
): Promise<SourceGrepResult> {
  const filters = input.filters.documents;
  const [total, rows] = await Promise.all([
    grepRepo.countDocumentGrepRows({
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
    }),
    grepRepo.searchDocumentGrepRows({
      userId,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      limit: input.headLimit,
      offset: input.offset,
      documentSource: filters?.documentSource,
      since: filters?.since,
      until: filters?.until,
      path: filters?.path,
      pathDocumentSource: filters?.pathDocumentSource,
      pathRest: filters?.pathRest,
      tag: filters?.tag,
    }),
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

export async function searchSource(
  userId: string,
  input: ValidatedGrepInput,
  source: ValidSource,
  agentId: string | undefined
): Promise<SourceGrepResult> {
  if (isMessageFamilySource(source)) {
    return searchMessageSource({ userId, input, source });
  }

  if (source === 'network') {
    return searchNetworkSource({ userId, input });
  }

  if (source === 'transactions') return searchTransactions(userId, input);
  if (source === 'documents') return searchDocuments(userId, input);

  if (source === 'agent_trajectories') return searchTrajectorySource(userId, input, agentId);

  const agentIds = await agentTreeIdsForGrep(userId, agentId);
  const agentNetworkFilters = input.filters.agentNetwork;
  const [total, rows] = await Promise.all([
    grepRepo.countAgentNetworkGrepRows({
      agentIds,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      pathAgentId: agentNetworkFilters?.pathAgentId,
      pathRole: agentNetworkFilters?.pathRole,
      pathMessageId: agentNetworkFilters?.pathMessageId,
      role: agentNetworkFilters?.role,
    }),
    grepRepo.searchAgentNetworkGrepRows({
      agentIds,
      pattern: input.dbPattern,
      caseInsensitive: input.caseInsensitive,
      limit: input.headLimit,
      offset: input.offset,
      pathAgentId: agentNetworkFilters?.pathAgentId,
      pathRole: agentNetworkFilters?.pathRole,
      pathMessageId: agentNetworkFilters?.pathMessageId,
      role: agentNetworkFilters?.role,
    }),
  ]);
  return { total, matches: rows.map((row) => buildAgentNetworkMatch(row, input)) };
}
