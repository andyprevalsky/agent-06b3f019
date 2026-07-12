import { createLogger } from '../../providers/logger';
import { getVerifiedStripeMetricsClient } from '../../providers/stripe';
import {
  buildSubscriberSeries,
  type SubscriberLifecycle,
  type SubscriberSeriesPoint,
} from './subscriberMetrics';
import type { AdminHealthPeriod } from './types';

const log = createLogger('AdminHealth');

export async function fetchStripeSubscribersByPeriod(
  periods: AdminHealthPeriod[]
): Promise<SubscriberSeriesPoint[]> {
  const now = new Date();
  const lifecycles: SubscriberLifecycle[] = [];
  try {
    const stripe = await getVerifiedStripeMetricsClient();
    for await (const subscription of stripe.subscriptions.list({
      status: 'all',
      created: { lt: Math.floor(now.getTime() / 1000) },
      limit: 100,
    })) {
      const customerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id;
      lifecycles.push({
        customerId,
        startedAt: new Date((subscription.start_date ?? subscription.created) * 1000),
        endedAt: subscription.ended_at === null ? null : new Date(subscription.ended_at * 1000),
        status: subscription.status,
      });
    }
  } catch (error) {
    log.error('Stripe subscriber fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  return buildSubscriberSeries(periods, lifecycles, now);
}
