/**
 * Data domain repo — all Prisma calls for data search and summary.
 */

import type { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';

/**
 * Resolve a person identifier (UUID, email, phone, or name) to a person ID.
 * Returns the person's id or null if not found.
 */
export async function resolvePersonId(
  personIdentifier: string,
  userId: string
): Promise<string | null> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    personIdentifier
  );

  let person;
  if (isUuid) {
    person = await prisma.person.findFirst({
      where: { id: personIdentifier, userId },
      select: { id: true },
    });
  } else {
    // Try email, phone, or name match
    person = await prisma.person.findFirst({
      where: {
        userId,
        OR: [
          { email: { equals: personIdentifier, mode: 'insensitive' } },
          { phoneNumber: personIdentifier },
          { firstName: { equals: personIdentifier, mode: 'insensitive' } },
          {
            AND: [
              { firstName: { equals: personIdentifier.split(' ')[0], mode: 'insensitive' } },
              {
                lastName: {
                  equals: personIdentifier.split(' ').slice(1).join(' '),
                  mode: 'insensitive',
                },
              },
            ],
          },
        ],
      },
      select: { id: true },
    });
  }

  return person?.id ?? null;
}

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
 * Count total messages for a user within a time range.
 */
export async function countMessages(userId: string, cutoffTime: Date): Promise<number> {
  return prisma.messageRecord.count({
    where: {
      person: { userId },
      timestamp: { gte: cutoffTime },
    },
  });
}

/**
 * Count threads (persons with messages) for a user within a time range.
 */
export async function countThreads(userId: string, cutoffTime: Date): Promise<number> {
  return prisma.person.count({
    where: {
      userId,
      messageRecords: { some: { timestamp: { gte: cutoffTime } } },
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
// Network (contacts) queries
// ---------------------------------------------------------------------------

/**
 * Search user's contact network by ILIKE across name, phone, email, company,
 * title, relation, and communicationFrequency. Ranked by messagesExchanged DESC.
 */
export async function searchContacts(params: {
  userId: string;
  pattern: string;
  limit: number;
}) {
  const { userId, pattern, limit } = params;

  const where: Prisma.PersonWhereInput = {
    userId,
    ...(pattern.length > 0
      ? {
          OR: [
            { firstName: { contains: pattern, mode: 'insensitive' as const } },
            { lastName: { contains: pattern, mode: 'insensitive' as const } },
            { email: { contains: pattern, mode: 'insensitive' as const } },
            { phoneNumber: { contains: pattern, mode: 'insensitive' as const } },
            { company: { contains: pattern, mode: 'insensitive' as const } },
            { title: { contains: pattern, mode: 'insensitive' as const } },
            { relation: { contains: pattern, mode: 'insensitive' as const } },
            { communicationFrequency: { contains: pattern, mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };

  const [total, matches] = await Promise.all([
    prisma.person.count({ where }),
    prisma.person.findMany({
      where,
      orderBy: [{ messagesExchanged: 'desc' }, { lastName: 'asc' }],
      take: limit,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        phoneNumber: true,
        email: true,
        company: true,
        title: true,
        relation: true,
        communicationFrequency: true,
        messagesExchanged: true,
      },
    }),
  ]);

  return { total, matches };
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

/** Search agent network messages by pattern across a set of agent IDs. */
export async function searchAgentNetworkMessages(params: {
  agentIds: string[];
  pattern: string;
  role: 'USER' | 'TOOL';
  limit: number;
}) {
  const { agentIds, pattern, role, limit } = params;

  const whereClause: Prisma.MessageWhereInput = {
    agentId: { in: agentIds },
    role,
    ...(pattern.length > 0 ? { text: { contains: pattern, mode: 'insensitive' as const } } : {}),
  };

  // For tool results, filter to FINISHED only
  if (role === 'TOOL') {
    whereClause.metadata = { path: ['toolStatus'], equals: 'FINISHED' };
  }

  return prisma.message.findMany({
    where: whereClause,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: {
      id: true,
      text: true,
      role: true,
      agentId: true,
      createdAt: true,
    },
  });
}
