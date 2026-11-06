/**
 * Repo queries backing the sidebar's two agent lists (active and archived).
 *
 * Split from repo.ts to keep that file inside the file-size budget. Both lists
 * read the same column set so `toListItem` in agentQueryService can map them
 * with one shape.
 */

import { prisma } from '../../providers/database';
import { AGENT_SEARCH_RESULT_LIMIT } from './types';

/** Columns the sidebar list views (active + archived) read. */
const AGENT_LIST_SELECT = {
  id: true,
  goal: true,
  title: true,
  pinnedAt: true,
  model: true,
  reasoningMaxTokens: true,
  source: true,
  progress: true,
  progressEstimate: true,
  progressEstimateGeneration: true,
  status: true,
  userControlRevision: true,
  statusMessage: true,
  temporalWorkflowId: true,
  tokenCount: true,
  tokensIn: true,
  tokensOut: true,
  contextSize: true,
  messageCount: true,
  fastModeCacheEnabled: true,
  speed: true,
  worldModelMode: true,
  memoryEnabled: true,
  projectId: true,
  folderId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

/** Fetch top-level agents for a user (no parent, not archived). Pinned first. */
export async function findTopLevelAgents(userId: string) {
  return prisma.agent.findMany({
    where: {
      userId,
      parentAgentId: null,
      deletedAt: null,
    },
    select: AGENT_LIST_SELECT,
    orderBy: [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  });
}

/**
 * Search active root chats by sidebar metadata or any message body.
 *
 * Tenant/archive/root constraints live in the same database predicate as the
 * content match so a later caller cannot accidentally search first and filter
 * sensitive rows in application memory. Trigram indexes in the accompanying
 * migration keep the three contains predicates viable as histories grow.
 */
export async function findTopLevelAgentsMatching(userId: string, query: string) {
  return prisma.agent.findMany({
    where: {
      userId,
      parentAgentId: null,
      deletedAt: null,
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { goal: { contains: query, mode: 'insensitive' } },
        { messages: { some: { text: { contains: query, mode: 'insensitive' } } } },
      ],
    },
    select: AGENT_LIST_SELECT,
    orderBy: [{ pinnedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: AGENT_SEARCH_RESULT_LIMIT,
  });
}

/**
 * Fetch archived (soft-deleted) top-level agents, most recently archived first.
 *
 * `take` is mandatory, not an optimization: the archive is append-only for the
 * life of an account, so an unbounded read would grow without limit. Served by
 * the existing @@index([userId, deletedAt]).
 */
export async function findArchivedTopLevelAgents(userId: string, limit: number) {
  return prisma.agent.findMany({
    where: {
      userId,
      parentAgentId: null,
      deletedAt: { not: null },
    },
    select: AGENT_LIST_SELECT,
    orderBy: { deletedAt: 'desc' },
    take: limit,
  });
}
