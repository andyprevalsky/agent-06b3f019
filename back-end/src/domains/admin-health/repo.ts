import { IntegrationStatus, type AgentStatus } from '@prisma/client';

import { prisma } from '../../providers/database';
import { isRealWaitlistPerson } from '../../providers/waitlistIdentity';

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

/** Cleared platform commerce (AgentCard + confirmed structured-output orders). */
export interface GmvRecord {
  userId: string;
  agentId: string | null;
  totalCents: number;
  createdAt: Date;
  provider: string;
  /** Andy, Tamara or Aman; everyone else counts only while a Stripe subscriber. */
  coreTeam: boolean;
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
 * Users who redeemed an invite code — in the app without paying.
 *
 * A redeemed invite code is one of the two ways the waitlist gate opens (the
 * other is an active subscription — see providers/inviteGate.ts:isUserGated),
 * so these people are in the product and must be counted alongside subscribers.
 *
 * createdAt stands in for "when they got in": redemption happens during
 * onboarding, right after the account row is written, and the schema keeps no
 * separate redemption timestamp.
 */
export async function findInviteCodeRedeemers(): Promise<UserCreatedRecord[]> {
  const users = await prisma.user.findMany({
    where: { usedInviteCode: { not: null }, phone: { not: null } },
    select: { userId: true, phone: true, createdAt: true },
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
  // A signup counts on email OR phone. This used to require a phone as a proxy
  // for "not fixture junk" — the ~2.7k phone-less rows are almost entirely our
  // own @blackbox-test.dev / @contract-test.dev fixtures — but that also
  // discarded every real email-only signup, including the whole public landing
  // form population. Fixtures are excluded by classification instead.
  const rows = await prisma.waitlist.findMany({
    where: { createdAt: { gte: start, lt: end } },
    select: { createdAt: true, name: true, email: true, phone: true },
  });
  return rows.filter(isRealWaitlistPerson).map(({ createdAt }) => ({ createdAt }));
}

// Waitlist-people queries live in their own file (per-file line budget) but
// stay reachable through this module so consumers import one repo namespace.
export * from './repoWaitlist';

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
