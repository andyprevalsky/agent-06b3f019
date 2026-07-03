/**
 * Data domain repo — all Prisma calls for data search and summary.
 */

import { prisma } from '../../providers/database';

/**
 * Search message records by pattern with optional person and time filters.
 */
export async function searchMessages(params: {
  userId: string;
  trimmedPattern: string;
  cutoffTime: Date;
  personId?: string;
  limit: number;
}) {
  const { userId, trimmedPattern, cutoffTime, personId, limit } = params;

  return prisma.messageRecord.findMany({
    where: {
      person: { userId },
      ...(trimmedPattern.length > 0
        ? { message: { contains: trimmedPattern, mode: 'insensitive' as const } }
        : {}),
      timestamp: { gte: cutoffTime },
      ...(personId !== undefined ? { personId } : {}),
    },
    orderBy: { timestamp: 'desc' },
    take: limit,
    select: {
      id: true,
      personId: true,
      channel: true,
      from: true,
      to: true,
      timestamp: true,
      message: true,
      person: {
        select: {
          firstName: true,
          lastName: true,
          phoneNumber: true,
          email: true,
        },
      },
    },
  });
}

/**
 * Fetch context messages around matches in a specific thread (person).
 */
export async function fetchContextMessages(params: {
  personId: string;
  userId: string;
  contextStart: Date;
  contextEnd: Date;
  takeLimit: number;
}) {
  const { personId, userId, contextStart, contextEnd, takeLimit } = params;

  return prisma.messageRecord.findMany({
    where: {
      personId,
      person: { userId },
      timestamp: { gte: contextStart, lte: contextEnd },
    },
    orderBy: { timestamp: 'asc' },
    take: takeLimit,
    select: {
      id: true,
      channel: true,
      from: true,
      to: true,
      timestamp: true,
      message: true,
    },
  });
}

/**
 * Count all messages for a user (no time filter).
 */
export async function countAllMessages(userId: string): Promise<number> {
  return prisma.messageRecord.count({
    where: { person: { userId } },
  });
}

/**
 * Get all threads (persons with messages) with stats for summary.
 */
export async function getThreadsWithStats(userId: string) {
  return prisma.person.findMany({
    where: {
      userId,
      messageRecords: { some: {} },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phoneNumber: true,
      _count: { select: { messageRecords: true } },
      messageRecords: {
        select: { timestamp: true, channel: true },
        orderBy: { timestamp: 'desc' },
        take: 1,
      },
    },
    orderBy: {
      messageRecords: { _count: 'desc' },
    },
  });
}

/**
 * Get channel breakdown (message count per channel) for a user.
 */
export async function getChannelCounts(userId: string) {
  return prisma.messageRecord.groupBy({
    by: ['channel'],
    where: { person: { userId } },
    _count: true,
  });
}

/**
 * Get the oldest message for a user.
 */
export async function getOldestMessage(userId: string) {
  return prisma.messageRecord.findFirst({
    where: { person: { userId } },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true },
  });
}

/**
 * Get the newest message for a user.
 */
export async function getNewestMessage(userId: string) {
  return prisma.messageRecord.findFirst({
    where: { person: { userId } },
    orderBy: { timestamp: 'desc' },
    select: { timestamp: true },
  });
}

// ---------------------------------------------------------------------------
// Agent network queries
// ---------------------------------------------------------------------------

/** Verify an agent belongs to the requesting user. */
export async function findAgentByIdAndUser(agentId: string, userId: string) {
  return prisma.agent.findFirst({
    where: { id: agentId, userId },
    select: { id: true },
  });
}

/** Walk up from an agent to the root, returning the root agent ID. Scoped to userId. */
export async function findRootAgentId(agentId: string, userId: string): Promise<string> {
  let currentId = agentId;
  let lastVerifiedId = agentId;
  const visited = new Set<string>();
  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const agent = await prisma.agent.findFirst({
      where: { id: currentId, userId },
      select: { parentAgentId: true },
    });
    if (agent === null) break; // Agent not owned by userId — stop at last verified
    lastVerifiedId = currentId;
    if (agent.parentAgentId === undefined || agent.parentAgentId === null) break;
    currentId = agent.parentAgentId;
  }
  return lastVerifiedId;
}

/** BFS walk from root to collect all agent IDs in the tree. Scoped to userId. */
export async function findAgentTreeIds(rootId: string, userId: string): Promise<string[]> {
  const treeIds: string[] = [];
  const seen = new Set<string>();
  const queue = [rootId];
  while (queue.length > 0) {
    const batch = queue.splice(0, queue.length);
    for (const id of batch) {
      if (seen.has(id)) continue;
      seen.add(id);
      treeIds.push(id);
    }
    const children = await prisma.agent.findMany({
      where: { parentAgentId: { in: batch }, userId },
      select: { id: true },
    });
    queue.push(...children.filter((c) => !seen.has(c.id)).map((c) => c.id));
  }
  return treeIds;
}

export async function getUserSnapshot(userId: string) {
  return prisma.userSnapshot.findUnique({
    where: { userId },
    select: {
      content: true,
      version: true,
      updatedAt: true,
      revisions: {
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: {
          id: true,
          source: true,
          changes: true,
          createdAt: true,
          model: true,
          promptKey: true,
        },
      },
    },
  });
}
