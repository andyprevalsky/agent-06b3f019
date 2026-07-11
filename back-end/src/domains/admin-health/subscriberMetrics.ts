import type { AdminHealthPeriod } from './types';

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

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
  return ACTIVE_SUBSCRIPTION_STATUSES.has(lifecycle.status) || lifecycle.endedAt !== null;
}

function wasSubscribedAt(lifecycle: SubscriberLifecycle, at: number): boolean {
  return (
    isCountableLifecycle(lifecycle) &&
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
        .filter((lifecycle) => wasSubscribedAt(lifecycle, end))
        .map((lifecycle) => lifecycle.customerId)
    );
    const newUsers = Array.from(firstSubscriptionByCustomer.values()).filter(
      (startedAt) => startedAt >= start && startedAt < end
    ).length;
    return { userCount: subscribedCustomers.size, newUsers };
  });
}
