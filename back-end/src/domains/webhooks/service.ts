import Stripe from 'stripe';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { getUserUsage } from '../../providers/credits';
import { createLogger } from '../../providers/logger';
import { getTemporalClient } from '../../providers/temporal';
import * as repo from './repo';
import { STRIPE_API_VERSION, STRIPE_WEBHOOK_SECRET } from './config';

const log = createLogger('Webhooks');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY ?? '', {
  apiVersion: STRIPE_API_VERSION,
});

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
  log.info('Payment successful', { invoice_id: invoice.id });

  const subscriptionId = invoice.subscription as string;

  if (subscriptionId === undefined || subscriptionId === null || subscriptionId === '') {
    log.info('No subscription associated with invoice');
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  const sessions = await stripe.checkout.sessions.list({
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

  await autoGenerateApiKeyIfNeeded(userId);
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
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(agent.temporalWorkflowId);
        await handle.signal('resume');
        log.info('Sent unpause signal to workflow', {
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
 * Auto-generate a Rose API key for the user if they don't have one
 * Called when user subscribes - gives them immediate API access
 */
async function autoGenerateApiKeyIfNeeded(userId: string): Promise<void> {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (
      supabaseUrl === undefined ||
      supabaseUrl === '' ||
      supabaseServiceKey === undefined ||
      supabaseServiceKey === ''
    ) {
      log.error('Missing Supabase credentials for API key generation');
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { data: existingKeys, error: fetchError } = await supabase
      .from('RoseApiKey')
      .select('id')
      .eq('userId', userId)
      .limit(1);

    if (fetchError !== null) {
      log.error('Error checking existing API keys', { error: String(fetchError) });
      return;
    }

    if (existingKeys !== null && existingKeys.length > 0) {
      log.info('User already has API keys, skipping auto-generation', { user_id: userId });
      return;
    }

    const apiKey = crypto.randomUUID().replace(/-/g, '');

    const { error: insertError } = await supabase.from('RoseApiKey').insert({
      userId,
      apiKey,
      name: 'Default (auto-generated)',
    });

    if (insertError !== null) {
      log.error('Error creating API key', { error: String(insertError) });
      return;
    }

    log.info('Auto-generated Rose API key for user', { user_id: userId });
  } catch (error) {
    log.error('Error in autoGenerateApiKeyIfNeeded', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
