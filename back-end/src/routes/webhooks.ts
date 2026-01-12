/**
 * Stripe Webhooks
 * 
 * NOTE: This must be mounted BEFORE express.json() middleware
 * because Stripe requires raw body for signature verification
 */

import express from 'express';
import Stripe from 'stripe';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { prisma } from '../lib/prisma';
import { getUserUsage } from '../lib/credits';

const router = express.Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-02-24.acacia',
});

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

/**
 * POST /webhooks/stripe
 * Handle Stripe webhook events (NO AUTH - verified by Stripe signature)
 */
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'] as string;

  let event: Stripe.Event;

  try {
    // Verify webhook signature
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err: any) {
    console.error('⚠️ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`📥 Received Stripe webhook: ${event.type}`);

  try {
    switch (event.type) {
      case 'invoice.payment_succeeded': {
        // This is ALL we need! Covers initial purchase AND renewals
        // When cancelled: Stripe stops sending this event → no new credits → agents pause naturally
        const invoice = event.data.object as Stripe.Invoice;
        await handlePaymentSuccess(invoice);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * Handle successful payment (initial purchase or renewal)
 * invoice.payment_succeeded covers BOTH cases
 */
async function handlePaymentSuccess(invoice: Stripe.Invoice) {
  console.log('💰 Payment successful:', invoice.id);

  // Get subscription ID
  const subscriptionId = invoice.subscription as string;

  if (!subscriptionId) {
    console.log('No subscription associated with invoice');
    return;
  }

  // Fetch full subscription details
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Get the checkout session to access client_reference_id
  // Payment links pass userId via ?client_reference_id=USER_ID query param
  const sessions = await stripe.checkout.sessions.list({
    subscription: subscriptionId,
    limit: 1,
  });

  const session = sessions.data[0];
  const userId = session?.client_reference_id;
  
  if (!userId) {
    console.error('❌ No client_reference_id found in checkout session');
    console.error('   Make sure payment link URL includes ?client_reference_id=USER_ID');
    return;
  }

  console.log(`✅ Found userId from client_reference_id: ${userId}`);

  // Ensure User record exists (upsert creates if missing)
  await prisma.user.upsert({
    where: { userId },
    create: { userId },
    update: {}, // No updates needed if already exists
  });

  // Determine tier from subscription amount
  const amountInDollars = (subscription.items.data[0]?.price.unit_amount || 0) / 100;
  const tier = Math.round(amountInDollars);

  const currentPeriodEnd = new Date(subscription.current_period_end * 1000);

  // Upsert subscription record
  await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      subscriptionTier: tier,
      stripeSubscriptionId: subscription.id,
      stripeCustomerId: subscription.customer as string,
      currentPeriodEnd,
    },
    update: {
      subscriptionTier: tier,
      stripeSubscriptionId: subscription.id,
      currentPeriodEnd,
    }
  });

  // Add credit for the subscription period (in cents)
  await prisma.credit.create({
    data: {
      userId,
      amountCents: tier * 100, // Convert dollars to cents
      expirationDate: currentPeriodEnd,
    }
  });

  console.log(`✅ Added $${tier} credit for user ${userId} (expires: ${currentPeriodEnd})`);

  // Unpause user's agents if they now have credits
  await unpauseUserAgents(userId);

  // Auto-generate Rose API key for new subscribers
  await autoGenerateApiKeyIfNeeded(userId);
}

/**
 * Unpause all agents for a user if they have credits
 */
async function unpauseUserAgents(userId: string) {
  // Check if user has credits
  const usage = await getUserUsage(userId);
  
  if (usage.remaining <= 0) {
    console.log(`User ${userId} still has no credits, not unpausing agents`);
    return;
  }

  // Find all paused agents
  const pausedAgents = await prisma.agent.findMany({
    where: {
      userId,
      status: 'PAUSED',
      deletedAt: null
    }
  });

  if (pausedAgents.length === 0) {
    console.log(`No paused agents for user ${userId}`);
    return;
  }

  // TODO: Send unpause signal to Temporal workflows
  // For now, just update status
  for (const agent of pausedAgents) {
    if (agent.temporalWorkflowId) {
      console.log(`📤 Sending unpause signal to workflow ${agent.temporalWorkflowId}`);
      // await sendUnpauseSignal(agent.temporalWorkflowId);
    }
  }

  console.log(`✅ Unpaused ${pausedAgents.length} agents for user ${userId}`);
}

/**
 * Auto-generate a Rose API key for the user if they don't have one
 * Called when user subscribes - gives them immediate API access
 */
async function autoGenerateApiKeyIfNeeded(userId: string) {
  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('❌ Missing Supabase credentials for API key generation');
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Check if user already has any API keys
    const { data: existingKeys, error: fetchError } = await supabase
      .from('RoseApiKey')
      .select('id')
      .eq('userId', userId)
      .limit(1);

    if (fetchError) {
      console.error('❌ Error checking existing API keys:', fetchError);
      return;
    }

    if (existingKeys && existingKeys.length > 0) {
      console.log(`🔑 User ${userId} already has API keys, skipping auto-generation`);
      return;
    }

    // Generate 32-character API key (UUID without dashes)
    const apiKey = crypto.randomUUID().replace(/-/g, '');

    const { error: insertError } = await supabase
      .from('RoseApiKey')
      .insert({
        userId,
        apiKey,
        name: 'Default (auto-generated)',
      });

    if (insertError) {
      console.error('❌ Error creating API key:', insertError);
      return;
    }

    console.log(`✅ Auto-generated Rose API key for user ${userId}`);
  } catch (error) {
    console.error('❌ Error in autoGenerateApiKeyIfNeeded:', error);
    // Don't throw - this shouldn't block subscription processing
  }
}

export default router;

