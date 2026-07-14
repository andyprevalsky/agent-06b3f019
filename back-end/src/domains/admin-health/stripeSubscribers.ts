import { createLogger } from '../../providers/logger';
import { getVerifiedStripeMetricsClient } from '../../providers/stripe';
import { ADMIN_HEALTH_ADDITIONAL_USER_IDS, ADMIN_HEALTH_EXCLUDED_USER_IDS } from './config';
import * as repo from './repo';
import {
  buildSubscriberSeries,
  type SubscriberLifecycle,
  type SubscriberSeriesPoint,
} from './subscriberMetrics';
import { recoverMissingStripeUserIds } from './stripeRecovery';
import type { AdminHealthPeriod } from './types';

const log = createLogger('AdminHealth');

export async function fetchStripeSubscribersByPeriod(
  periods: AdminHealthPeriod[],
  retrievalTime = new Date()
): Promise<SubscriberSeriesPoint[]> {
  const lifecycles: SubscriberLifecycle[] = [];
  const subscriptionIdsByCustomerId = new Map<string, string[]>();
  try {
    const stripe = await getVerifiedStripeMetricsClient();
    for await (const subscription of stripe.subscriptions.list({
      status: 'all',
      created: { lt: Math.floor(retrievalTime.getTime() / 1000) },
      limit: 100,
    })) {
      const customerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id;
      lifecycles.push({
        customerId,
        userId: null,
        startedAt: new Date((subscription.start_date ?? subscription.created) * 1000),
        endedAt: subscription.ended_at === null ? null : new Date(subscription.ended_at * 1000),
        status: subscription.status,
      });
      const subscriptionIds = subscriptionIdsByCustomerId.get(customerId) ?? [];
      subscriptionIds.push(subscription.id);
      subscriptionIdsByCustomerId.set(customerId, subscriptionIds);
    }

    const [subscriptionUsers, additionalUsers] = await Promise.all([
      repo.findSubscriptionUsersByCustomerIds(lifecycles.map((lifecycle) => lifecycle.customerId)),
      repo.findUsersByIds(Array.from(ADMIN_HEALTH_ADDITIONAL_USER_IDS)),
    ]);
    const userIdByCustomerId = new Map(
      subscriptionUsers.map((subscription) => [subscription.stripeCustomerId, subscription.userId])
    );

    // Recover missing local mappings from the same checkout-session client_reference_id used by
    // webhooks. Bound concurrent Stripe calls while checking every customer accurately.
    await recoverMissingStripeUserIds(
      subscriptionIdsByCustomerId,
      userIdByCustomerId,
      async (subscriptionId) => {
        const sessions = await stripe.checkout.sessions.list({
          subscription: subscriptionId,
          limit: 1,
        });
        return sessions.data[0]?.client_reference_id;
      }
    );

    return buildSubscriberSeries(
      periods,
      lifecycles.map((lifecycle) => {
        const userId = userIdByCustomerId.get(lifecycle.customerId);
        return {
          ...lifecycle,
          userId:
            userId === undefined || ADMIN_HEALTH_EXCLUDED_USER_IDS.has(userId) ? null : userId,
        };
      }),
      retrievalTime,
      additionalUsers.map((user) => ({ userId: user.userId, startedAt: user.createdAt }))
    );
  } catch (error) {
    log.error('Stripe subscriber fetch failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
