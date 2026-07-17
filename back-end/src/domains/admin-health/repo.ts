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

export interface WaitlistSignupRecord {
  createdAt: Date;
}

export interface SubscriptionUserRecord {
  userId: string;
  stripeCustomerId: string;
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

export async function findVerifiedUsersCreatedBefore(
  end: Date,
  excludedUserIds: string[]
): Promise<UserCreatedRecord[]> {
  const users = await prisma.user.findMany({
    where: {
      isAnonymous: false,
      phone: { not: null },
      userId: { notIn: excludedUserIds },
      createdAt: { lt: end },
    },
    select: {
      userId: true,
      createdAt: true,
      phone: true,
    },
  });
  return users
    .filter((user) => (user.phone ?? '').trim() !== '')
    .map(({ userId, createdAt }) => ({ userId, createdAt }));
}

export async function findUsersByIds(userIds: string[]): Promise<UserCreatedRecord[]> {
  if (userIds.length === 0) return [];
  return prisma.user.findMany({
    where: { userId: { in: userIds }, isAnonymous: false },
    select: { userId: true, createdAt: true },
  });
}

export async function findSubscriptionUsersByCustomerIds(
  stripeCustomerIds: string[]
): Promise<SubscriptionUserRecord[]> {
  if (stripeCustomerIds.length === 0) return [];
  return prisma.subscription.findMany({
    where: { stripeCustomerId: { in: stripeCustomerIds } },
    select: { userId: true, stripeCustomerId: true },
  });
}

export async function findWaitlistSignupsBetween(
  start: Date,
  end: Date
): Promise<WaitlistSignupRecord[]> {
  // Only phone-bearing signups count. The legacy email waitlist (~3k rows with
  // no phone) is not a real product signup, so entries without a phone number
  // are cleared out of this metric.
  const rows = await prisma.waitlist.findMany({
    where: { createdAt: { gte: start, lt: end }, phone: { not: null } },
    select: { createdAt: true, phone: true },
  });
  return rows
    .filter((row) => (row.phone ?? '').trim() !== '')
    .map(({ createdAt }) => ({ createdAt }));
}

export interface WaitlistPersonRow {
  id: string;
  name: string;
  phone: string;
  variant: string | null;
  createdAt: Date;
  invitedAt: Date | null;
}

/**
 * All actionable waitlist people — the same phone-bearing population the
 * signup metric counts. Newest first. Email-only legacy rows (no phone) are
 * excluded because they can't be texted.
 */
export async function findWaitlistPeople(): Promise<WaitlistPersonRow[]> {
  const rows = await prisma.waitlist.findMany({
    where: { phone: { not: null } },
    select: {
      id: true,
      name: true,
      phone: true,
      variant: true,
      createdAt: true,
      invitedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
  return rows
    .filter((row) => (row.phone ?? '').trim() !== '')
    .map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone as string,
      variant: row.variant,
      createdAt: row.createdAt,
      invitedAt: row.invitedAt,
    }));
}

export async function findWaitlistPersonById(id: string): Promise<WaitlistPersonRow | null> {
  const row = await prisma.waitlist.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      phone: true,
      variant: true,
      createdAt: true,
      invitedAt: true,
    },
  });
  if (row === null || (row.phone ?? '').trim() === '') return null;
  return {
    id: row.id,
    name: row.name,
    phone: row.phone as string,
    variant: row.variant,
    createdAt: row.createdAt,
    invitedAt: row.invitedAt,
  };
}

export interface AccountGateRecord {
  phone: string;
  usedInviteCode: number | null;
}

/** Accounts matching any of the given E.164 phone numbers, with gate state. */
export async function findAccountsByPhones(phones: string[]): Promise<AccountGateRecord[]> {
  if (phones.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { phone: { in: phones } },
    select: { phone: true, usedInviteCode: true },
  });
  return users
    .filter((user) => (user.phone ?? '').trim() !== '')
    .map((user) => ({ phone: user.phone as string, usedInviteCode: user.usedInviteCode }));
}

export async function markWaitlistInvited(id: string, invitedAt: Date): Promise<void> {
  await prisma.waitlist.update({ where: { id }, data: { invitedAt } });
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
