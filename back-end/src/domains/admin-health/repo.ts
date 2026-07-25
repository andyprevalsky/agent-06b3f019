import { IntegrationStatus, type AgentStatus } from '@prisma/client';

import { prisma } from '../../providers/database';

export interface AdminUserRecord {
  userId: string;
  phone: string | null;
}

export interface RootTaskRecord {
  taskId: string;
  userId: string;
  goal: string;
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

export interface ConnectedConnectorRecord {
  userId: string;
  name: string;
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

/**
 * Active connector rows that have reached a connected state. SYNCING is
 * included only for already-active rows (for example Gmail during a refresh),
 * while first-time uploads remain inactive until their import succeeds.
 */
export async function findConnectedConnectors(): Promise<ConnectedConnectorRecord[]> {
  return prisma.integration.findMany({
    where: {
      isActive: true,
      status: { in: [IntegrationStatus.CONNECTED, IntegrationStatus.SYNCING] },
    },
    select: { userId: true, name: true },
  });
}

// Resolve the explicit core-team allowlist (see ADMIN_HEALTH_ADDITIONAL_PHONES) by
// phone. isAnonymous is intentionally NOT filtered here: the dev/test account is
// flagged anonymous but is a real person we always want counted. One user per phone
// (earliest-created) guards against a phone that later gains a second account
// double-counting in the "# of Users" set.
export async function findUsersByPhones(phones: string[]): Promise<UserCreatedRecord[]> {
  if (phones.length === 0) return [];
  const rows = await prisma.user.findMany({
    where: { phone: { in: phones } },
    select: { userId: true, phone: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const byPhone = new Map<string, UserCreatedRecord>();
  for (const { userId, phone, createdAt } of rows) {
    if (phone === null || byPhone.has(phone)) continue;
    byPhone.set(phone, { userId, createdAt });
  }
  return Array.from(byPhone.values());
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
  email: string | null;
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
      email: true,
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
      email: row.email,
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
      email: true,
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
    email: row.email,
    phone: row.phone as string,
    variant: row.variant,
    createdAt: row.createdAt,
    invitedAt: row.invitedAt,
  };
}

export async function findUserEmailById(userId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { email: true },
  });
  const email = user?.email?.trim() ?? '';
  return email === '' ? null : email;
}

export interface AccountGateRecord {
  phone: string;
  usedInviteCode: number | null;
  hasActiveSubscription: boolean;
}

function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? '').replace(/\D/g, '');
}

/**
 * Accounts matching any of the given phone numbers, with gate state. Matches on
 * canonical digits ('+digits' or bare 'digits') so a differently-formatted
 * User.phone still resolves, and reports whether each holds an active
 * subscription (which clears the invite gate).
 */
export async function findAccountsByPhones(phones: string[]): Promise<AccountGateRecord[]> {
  const candidates = new Set<string>();
  for (const phone of phones) {
    const digits = phoneDigits(phone);
    if (digits === '') continue;
    candidates.add('+' + digits);
    candidates.add(digits);
  }
  if (candidates.size === 0) return [];

  const users = await prisma.user.findMany({
    where: { phone: { in: Array.from(candidates) } },
    select: { userId: true, phone: true, usedInviteCode: true },
  });
  const userIds = users.map((user) => user.userId);
  const activeSubs =
    userIds.length === 0
      ? []
      : await prisma.subscription.findMany({
          where: { userId: { in: userIds }, currentPeriodEnd: { gt: new Date() } },
          select: { userId: true },
        });
  const activeSubUserIds = new Set(activeSubs.map((sub) => sub.userId));

  return users
    .filter((user) => (user.phone ?? '').trim() !== '')
    .map((user) => ({
      phone: user.phone as string,
      usedInviteCode: user.usedInviteCode,
      hasActiveSubscription: activeSubUserIds.has(user.userId),
    }));
}

export async function markWaitlistInvited(id: string, invitedAt: Date): Promise<void> {
  await prisma.waitlist.update({ where: { id }, data: { invitedAt } });
}

export async function findRootTasksBetween(start: Date, end: Date): Promise<RootTaskRecord[]> {
  const [liveTasks, archivedTasks] = await Promise.all([
    // isBenchmark: false strips benchmark/eval runs (which create real root agents
    // under an operator's account) from every task metric. See agents/routes.ts.
    prisma.agent.findMany({
      where: { parentAgentId: null, isBenchmark: false, createdAt: { gte: start, lt: end } },
      select: {
        id: true,
        userId: true,
        goal: true,
        createdAt: true,
        tokensOut: true,
        status: true,
      },
    }),
    prisma.goalHistory.findMany({
      where: { depth: 0, isBenchmark: false, agentCreatedAt: { gte: start, lt: end } },
      select: {
        originalAgentId: true,
        userId: true,
        goal: true,
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
      goal: task.goal,
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
      where: { parentAgentId: null, isBenchmark: false, createdAt: { lt: end } },
      _min: { createdAt: true },
    }),
    prisma.goalHistory.groupBy({
      by: ['userId'],
      where: { depth: 0, isBenchmark: false, agentCreatedAt: { lt: end } },
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
