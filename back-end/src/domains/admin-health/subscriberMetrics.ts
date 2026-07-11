import type { AdminHealthPeriod } from './types';

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);
const NEVER_ACTIVATED_SUBSCRIPTION_STATUSES = new Set(['incomplete', 'incomplete_expired']);

export interface SubscriberLifecycle {
  customerId: string;
  startedAt: Date;
  endedAt: Date | null;
  status: string;
}

export interface SubscriberSeriesPoint {
  userCount: number;
  newUsers: number;
}

function isCountableLifecycle(lifecycle: SubscriberLifecycle): boolean {
  return !NEVER_ACTIVATED_SUBSCRIPTION_STATUSES.has(lifecycle.status);
}

function wasSubscribedAt(lifecycle: SubscriberLifecycle, at: number, now: number): boolean {
  const isCurrentSnapshot = at >= now && lifecycle.endedAt === null;
  return (
    isCountableLifecycle(lifecycle) &&
    (!isCurrentSnapshot || ACTIVE_SUBSCRIPTION_STATUSES.has(lifecycle.status)) &&
    lifecycle.startedAt.getTime() < at &&
    (lifecycle.endedAt === null || lifecycle.endedAt.getTime() > at)
  );
}

export function buildSubscriberSeries(
  periods: AdminHealthPeriod[],
  lifecycles: SubscriberLifecycle[],
  now = new Date()
): SubscriberSeriesPoint[] {
  const eligible = lifecycles.filter(isCountableLifecycle);
  const firstSubscriptionByCustomer = new Map<string, number>();
  for (const lifecycle of eligible) {
    const startedAt = lifecycle.startedAt.getTime();
    const current = firstSubscriptionByCustomer.get(lifecycle.customerId);
    if (current === undefined || startedAt < current) {
      firstSubscriptionByCustomer.set(lifecycle.customerId, startedAt);
    }
  }

  return periods.map((period) => {
    const start = Date.parse(period.start);
    const end = Math.min(Date.parse(period.end), now.getTime());
    const subscribedCustomers = new Set(
      eligible
        .filter((lifecycle) => wasSubscribedAt(lifecycle, end, now.getTime()))
        .map((lifecycle) => lifecycle.customerId)
    );
    const newUsers = Array.from(firstSubscriptionByCustomer.values()).filter(
      (startedAt) => startedAt >= start && startedAt < end
    ).length;
    return { userCount: subscribedCustomers.size, newUsers };
  });
}
