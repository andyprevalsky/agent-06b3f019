import type { AgentStatus } from '@prisma/client';

import { prisma } from '../../providers/database';

export interface AdminUserRecord {
  userId: string;
  phone: string | null;
}

export interface RootTaskRecord {
  taskId: string;
  userId: string;
  createdAt: Date;
  tokensOut: number;
  status: AgentStatus;
}

export interface UserCreatedRecord {
  userId: string;
  createdAt: Date;
}

export async function findUserForAdminCheck(userId: string): Promise<AdminUserRecord | null> {
  return prisma.user.findUnique({
    where: { userId },
    select: { userId: true, phone: true },
  });
}

export async function countUsersCreatedBefore(end: Date): Promise<number> {
  return prisma.user.count({
    where: {
      isAnonymous: false,
      createdAt: { lt: end },
    },
  });
}

export async function findUsersCreatedBetween(
  start: Date,
  end: Date
): Promise<UserCreatedRecord[]> {
  return prisma.user.findMany({
    where: {
      isAnonymous: false,
      createdAt: { gte: start, lt: end },
    },
    select: {
      userId: true,
      createdAt: true,
    },
  });
}

export async function findRootTasksBetween(start: Date, end: Date): Promise<RootTaskRecord[]> {
  const [liveTasks, archivedTasks] = await Promise.all([
    prisma.agent.findMany({
      where: { parentAgentId: null, createdAt: { gte: start, lt: end } },
      select: { id: true, userId: true, createdAt: true, tokensOut: true, status: true },
    }),
    prisma.goalHistory.findMany({
      where: { depth: 0, agentCreatedAt: { gte: start, lt: end } },
      select: {
        originalAgentId: true,
        userId: true,
        agentCreatedAt: true,
        tokensOut: true,
        status: true,
      },
    }),
  ]);
  const tasks = new Map<string, RootTaskRecord>();
  for (const task of archivedTasks) {
    tasks.set(task.originalAgentId, {
      taskId: task.originalAgentId,
      userId: task.userId,
      createdAt: task.agentCreatedAt,
      tokensOut: task.tokensOut,
      status: task.status,
    });
  }
  for (const task of liveTasks) {
    tasks.set(task.id, { taskId: task.id, ...task });
  }
  return Array.from(tasks.values());
}

export async function findFirstRootTasksByUserBetween(
  start: Date,
  end: Date
): Promise<Array<{ userId: string; firstTaskAt: Date }>> {
  const [liveRows, archivedRows] = await Promise.all([
    prisma.agent.groupBy({
      by: ['userId'],
      where: { parentAgentId: null, createdAt: { lt: end } },
      _min: { createdAt: true },
    }),
    prisma.goalHistory.groupBy({
      by: ['userId'],
      where: { depth: 0, agentCreatedAt: { lt: end } },
      _min: { agentCreatedAt: true },
    }),
  ]);
  const firstByUser = new Map<string, Date>();
  const recordFirst = (userId: string, date: Date | null) => {
    if (date === null) return;
    const current = firstByUser.get(userId);
    if (current === undefined || date < current) firstByUser.set(userId, date);
  };
  for (const row of archivedRows) recordFirst(row.userId, row._min.agentCreatedAt);
  for (const row of liveRows) recordFirst(row.userId, row._min.createdAt);
  return Array.from(firstByUser, ([userId, firstTaskAt]) => ({ userId, firstTaskAt })).filter(
    ({ firstTaskAt }) => firstTaskAt >= start
  );
}
