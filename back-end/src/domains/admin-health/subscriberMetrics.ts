import type { AdminHealthPeriod } from './types';

const KNOWN_MEMBERSHIP_STATUSES = new Set(['active', 'trialing', 'canceled']);

export interface SubscriberLifecycle {
  customerId: string;
  userId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  status: string;
}

export interface SubscriberSeriesPoint {
  userCount: number;
  newUsers: number;
  userIds: Set<string>;
  /** Stripe subscribers only (no invite-code redeemers or core-team additions). */
  subscribedUserIds: Set<string>;
}

export interface AdditionalUserLifecycle {
  userId: string;
  startedAt: Date;
}

function isCountableLifecycle(lifecycle: SubscriberLifecycle): boolean {
  return KNOWN_MEMBERSHIP_STATUSES.has(lifecycle.status);
}

function wasIncludedAt(lifecycle: SubscriberLifecycle, at: number): boolean {
  return (
    isCountableLifecycle(lifecycle) &&
    lifecycle.startedAt.getTime() < at &&
    (lifecycle.endedAt === null || lifecycle.endedAt.getTime() > at)
  );
}

export function buildSubscriberSeries(
  periods: AdminHealthPeriod[],
  lifecycles: SubscriberLifecycle[],
  now = new Date(),
  additionalUsers: AdditionalUserLifecycle[] = []
): SubscriberSeriesPoint[] {
  const eligible = lifecycles.filter(isCountableLifecycle);
  const firstInclusionByUser = new Map<string, number>();
  for (const lifecycle of eligible) {
    if (lifecycle.userId === null) continue;
    const startedAt = lifecycle.startedAt.getTime();
    const current = firstInclusionByUser.get(lifecycle.userId);
    if (current === undefined || startedAt < current) {
      firstInclusionByUser.set(lifecycle.userId, startedAt);
    }
  }
  for (const user of additionalUsers) {
    const startedAt = user.startedAt.getTime();
    const current = firstInclusionByUser.get(user.userId);
    if (current === undefined || startedAt < current) {
      firstInclusionByUser.set(user.userId, startedAt);
    }
  }

  return periods.map((period) => {
    const start = Date.parse(period.start);
    const end = Math.min(Date.parse(period.end), now.getTime());
    const userIds = new Set(
      eligible
        .filter((lifecycle) => wasIncludedAt(lifecycle, end))
        .flatMap((lifecycle) => (lifecycle.userId === null ? [] : [lifecycle.userId]))
    );
    const subscribedUserIds = new Set(userIds);
    for (const user of additionalUsers) {
      if (user.startedAt.getTime() < end) userIds.add(user.userId);
    }
    const newUserIds = new Set(
      Array.from(firstInclusionByUser.entries())
        .filter(([, startedAt]) => startedAt >= start && startedAt < end)
        .map(([userId]) => userId)
    );
    for (const userId of newUserIds) {
      if (!userIds.has(userId)) newUserIds.delete(userId);
    }
    return { userCount: userIds.size, newUsers: newUserIds.size, userIds, subscribedUserIds };
  });
}
