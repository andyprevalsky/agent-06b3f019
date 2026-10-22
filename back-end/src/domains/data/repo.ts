/**
 * Data domain repo — all Prisma calls for data search and summary.
 */

import { IntegrationStatus } from '@prisma/client';
import { prisma } from '../../providers/database';

/**
 * True when the user has a CONNECTED Integration row for the given connector
 * name (e.g. 'gmail', 'imessage', 'plaid'). Used by per-source connectivity.
 */
export async function isConnectorConnected(userId: string, connector: string): Promise<boolean> {
  const integration = await prisma.integration.findFirst({
    where: { userId, name: connector, status: IntegrationStatus.CONNECTED },
    select: { id: true },
  });
  return integration !== null;
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
    select: {
      timestamp: true,
      channel: true,
      from: true,
      to: true,
      message: true,
    },
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

/**
 * Live agents of one tree at task path `path` or below it. Task paths are
 * unique only among live agents, so an archived agent may share a path and is
 * excluded. One read on the (busId, taskPath) index; the root row matches by id.
 */
export async function findTreeAgentsAtOrBelowPath(rootId: string, userId: string, path: string) {
  return prisma.agent.findMany({
    where: {
      userId,
      deletedAt: null,
      OR: [{ id: rootId }, { busId: rootId }],
      AND: [{ OR: [{ taskPath: path }, { taskPath: { startsWith: `${path}/` } }] }],
    },
    select: { id: true, taskPath: true },
  });
}

/** The owner row at `path` in one tree (the root when `path` is `/root`), with its tasks. */
export async function findTreeAgentAtPath(rootId: string, userId: string, path: string) {
  return prisma.agent.findFirst({
    where:
      path === '/root'
        ? { id: rootId, userId }
        : { userId, OR: [{ id: rootId }, { busId: rootId }], taskPath: path, deletedAt: null },
    select: { id: true, backgroundTasks: true },
  });
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
