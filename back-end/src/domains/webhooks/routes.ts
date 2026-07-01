/**
 * Stripe Webhooks
 *
 * NOTE: This must be mounted BEFORE express.json() middleware
 * because Stripe requires raw body for signature verification
 */

import express from 'express';
import type Stripe from 'stripe';
import { createLogger } from '../../providers/logger';
import { asyncHandler } from '../../utils/asyncHandler';
import * as service from './service';

const log = createLogger('Webhooks');

const router = express.Router();

/**
 * POST /webhooks/stripe
 * Handle Stripe webhook events (NO AUTH - verified by Stripe signature)
 */
router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'];

    if (typeof sig !== 'string' || sig === '') {
      res.status(400).send('Missing stripe-signature header');
      return;
    }

    let event: Stripe.Event;

    try {
      event = service.constructStripeEvent(req.body as Buffer, sig);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Webhook signature verification failed', { error: message });
      res.status(400).send(`Webhook Error: ${message}`);
      return;
    }

    log.info('Received Stripe webhook', { event_type: event.type });

    /* c8 ignore start -- requires valid Stripe signature to reach; constructStripeEvent blocks without STRIPE_WEBHOOK_SECRET */
    try {
      switch (event.type) {
        case 'invoice.payment_succeeded': {
          const invoice = event.data.object as Stripe.Invoice;
          await service.handlePaymentSuccess(invoice);
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice;
          await service.handlePaymentFailed(invoice);
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          await service.handleSubscriptionDeleted(subscription);
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription;
          await service.handleSubscriptionUpdated(subscription);
          break;
        }

        default:
          log.info('Unhandled event type', { event_type: event.type });
      }

      res.json({ received: true });
    } catch (error) {
      log.error('Error processing webhook', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Webhook processing failed' });
    }
    /* c8 ignore stop */
  })
);

export default router;
