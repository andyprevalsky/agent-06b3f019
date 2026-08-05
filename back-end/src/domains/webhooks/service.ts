import { stripe, getStripeClientForLivemode, type Stripe } from '../../providers/stripe';
import { getUserUsage } from '../../providers/credits';
import { resumeAgentWorkflow } from '../../providers/agentResume';
import { createLogger } from '../../providers/logger';
import { getTemporalClient } from '../../providers/temporal';
import { resolvePendingGateByKey } from '../../providers/gateResolution';
import { ensureRoseApiKeyForUser } from '../../providers/supabaseApiKeys';
import * as repo from './repo';
import { STRIPE_WEBHOOK_SECRET } from './config';

const log = createLogger('Webhooks');

/**
 * Verify and construct a Stripe webhook event from raw body + signature
 */
export function constructStripeEvent(rawBody: Buffer, signature: string): Stripe.Event {
  return stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
}

/**
 * Handle successful payment (initial purchase or renewal)
 * invoice.payment_succeeded covers BOTH cases
 */
export async function handlePaymentSuccess(invoice: Stripe.Invoice): Promise<void> {
  log.info('Payment successful', { invoice_id: invoice.id, livemode: invoice.livemode });

  const subscriptionId = invoice.subscription as string;

  if (subscriptionId === undefined || subscriptionId === null || subscriptionId === '') {
    log.info('No subscription associated with invoice');
    return;
  }

  // Live checkouts land on the live Rose Labs account; the sandbox billing
  // singleton cannot retrieve those subscription/session objects.
  const stripeClient = getStripeClientForLivemode(invoice.livemode === true);

  const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);

  const sessions = await stripeClient.checkout.sessions.list({
    subscription: subscriptionId,
    limit: 1,
  });

  const session = sessions.data[0];
  const userId = session?.client_reference_id;

  if (userId === undefined || userId === null || userId === '') {
    log.error('No client_reference_id found in checkout session');
    log.error('Make sure payment link URL includes ?client_reference_id=USER_ID');
    return;
  }

  log.info('Found userId from client_reference_id', { user_id: userId });

  await repo.upsertUser(userId);

  const unitAmount = subscription.items.data[0]?.price.unit_amount;
  const amountInDollars = (unitAmount ?? 0) / 100;
  const tier = Math.round(amountInDollars);

  const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

  await repo.upsertSubscription({
    userId,
    subscriptionTier: tier,
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: subscription.customer as string,
    currentPeriodEnd,
  });

  await repo.createCredit({
    userId,
    amountCents: tier * 100,
    expirationDate: currentPeriodEnd,
  });

  log.info('Added credit for user', {
    user_id: userId,
    tier_dollars: tier,
    expires: currentPeriodEnd.toISOString(),
  });

  await unpauseUserAgents(userId);
  await resolvePendingGateByKey(userId, 'subscription', 'SUBSCRIPTION_ACTIVE');

  await ensureRoseApiKeyForUser(userId);
}

/**
 * Unpause all agents for a user if they have credits
 */
async function unpauseUserAgents(userId: string): Promise<void> {
  const usage = await getUserUsage(userId);

  if (usage.remaining <= 0) {
    log.info('User still has no credits, not unpausing agents', { user_id: userId });
    return;
  }

  const pausedAgents = await repo.findPausedAgents(userId);

  if (pausedAgents.length === 0) {
    log.info('No paused agents for user', { user_id: userId });
    return;
  }

  for (const agent of pausedAgents) {
    if (agent.temporalWorkflowId !== null && agent.temporalWorkflowId !== '') {
      try {
        const result = await resumeAgentWorkflow(agent.id);
        if ('error' in result) throw new Error(result.error);
        log.info('Persisted credit restoration and resumed agent', {
          workflow_id: agent.temporalWorkflowId,
          agent_id: agent.id,
        });
      } catch (error) {
        log.warn('Failed to send unpause signal, skipping agent', {
          workflow_id: agent.temporalWorkflowId,
          agent_id: agent.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  log.info('Unpaused agents for user', {
    user_id: userId,
    count: pausedAgents.length,
  });
}

/**
 * Pause all ACTIVE agents for a user (inverse of unpauseUserAgents).
 * Used when a subscription lapses (failed renewal, cancellation, non-active status) so
 * the agent stops drawing on credits/compute the user is no longer paying for.
 */
async function pauseUserAgents(userId: string): Promise<void> {
  const activeAgents = await repo.findActiveAgents(userId);

  if (activeAgents.length === 0) {
    log.info('No active agents to pause', { user_id: userId });
    return;
  }

  for (const agent of activeAgents) {
    if (agent.temporalWorkflowId !== null && agent.temporalWorkflowId !== '') {
      try {
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(agent.temporalWorkflowId);
        await handle.signal('pause');
        await repo.updateAgentStatus(agent.id, 'PAUSED');
        log.info('Paused agent (subscription lapsed)', {
          workflow_id: agent.temporalWorkflowId,
          agent_id: agent.id,
        });
      } catch (error) {
        log.warn('Failed to send pause signal, skipping agent', {
          workflow_id: agent.temporalWorkflowId,
          agent_id: agent.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  log.info('Paused agents for user (subscription lapsed)', {
    user_id: userId,
    count: activeAgents.length,
  });
}

/** Stripe statuses where the user still has access; anything else is treated as lapsed. */
const ACTIVE_SUBSCRIPTION_STATUSES = new Set<string>(['active', 'trialing']);

/** Resolve the local userId behind a Stripe subscription id (null when we have no record). */
async function resolveUserIdFromStripeSubscription(
  stripeSubscriptionId: string | null | undefined
): Promise<string | null> {
  if (
    stripeSubscriptionId === undefined ||
    stripeSubscriptionId === null ||
    stripeSubscriptionId === ''
  ) {
    return null;
  }
  const subscription = await repo.findSubscriptionByStripeSubscriptionId(stripeSubscriptionId);
  return subscription?.userId ?? null;
}

/**
 * Handle a failed renewal payment. Stripe will retry (dunning); we pause the user's running
 * agents so they stop spending while past_due. A successful retry fires
 * invoice.payment_succeeded, which unpauses them again.
 */
export async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  const subscriptionId = invoice.subscription as string | null;
  log.info('Invoice payment failed', { invoice_id: invoice.id, subscription_id: subscriptionId });

  const userId = await resolveUserIdFromStripeSubscription(subscriptionId);
  if (userId === null) {
    log.info('No local subscription for failed invoice; nothing to pause');
    return;
  }

  await pauseUserAgents(userId);
}

/**
 * Handle a fully canceled/ended subscription. Revoke: pause running agents and remove the
 * local subscription record (which also blocks new agent-card mints, since mint requires a
 * subscription). Re-subscribing re-creates the record via handlePaymentSuccess.
 */
export async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  log.info('Subscription deleted', { subscription_id: subscription.id });

  const userId = await resolveUserIdFromStripeSubscription(subscription.id);
  if (userId === null) {
    log.info('No local subscription record for deleted subscription; nothing to revoke');
    return;
  }

  await pauseUserAgents(userId);
  await repo.deleteSubscriptionByUserId(userId);
  log.info('Revoked subscription for user', { user_id: userId });
}

/**
 * Handle a subscription status/plan change. Keep the local record (tier + period end) in
 * sync, and if the subscription is no longer active/trialing (past_due, canceled, unpaid,
 * incomplete_expired, …) pause the user's running agents. Returning to active is handled by
 * invoice.payment_succeeded (which unpauses).
 */
export async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  log.info('Subscription updated', {
    subscription_id: subscription.id,
    status: subscription.status,
  });

  const userId = await resolveUserIdFromStripeSubscription(subscription.id);
  if (userId === null) {
    log.info('No local subscription record for updated subscription; skipping');
    return;
  }

  const unitAmount = subscription.items.data[0]?.price.unit_amount;
  const tier = Math.round((unitAmount ?? 0) / 100);

  await repo.upsertSubscription({
    userId,
    subscriptionTier: tier,
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: subscription.customer as string,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000),
  });

  if (!ACTIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) {
    log.info('Subscription no longer active, pausing agents', {
      user_id: userId,
      status: subscription.status,
    });
    await pauseUserAgents(userId);
  }
}
