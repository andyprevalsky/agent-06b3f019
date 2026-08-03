/**
 * Hosted Stripe Checkout endpoints for /test_payment — the real-merchant path that lets a LIVE
 * Rose-minted AgentCard actually be authorized (AgentCard's `test_charge` is sandbox-only).
 *
 * Both routes acquire on the dedicated merchant key
 * (`TEST_PAYMENT_MERCHANT_STRIPE_SECRET_KEY`), never on the `stripe` billing singleton — see
 * `./checkout.ts` and providers/stripe.ts. A missing merchant key surfaces here as a 503
 * TestPaymentError naming the env var, rather than a generic 500.
 */

import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { createTestPaymentCheckoutSession, settleTestPaymentCheckoutSession } from './checkout';
import { rejectWhenDisabled } from './routes.guards';
import { TestPaymentError } from './errors';
import type { TestPaymentLineItem } from './types';

export const checkoutRouter = Router();

// Real-merchant path: hand the shopper a hosted Stripe Checkout instead of taking the PAN
// ourselves. This is the only way a LIVE Rose-minted card can be authorized (AgentCard's
// test_charge is sandbox-only; live-mode raw-PAN tokenization is blocked by Stripe).
checkoutRouter.post(
  '/checkout-session',
  asyncHandler(async (req, res) => {
    if (rejectWhenDisabled(res, { allowProductionBenchmark: true })) return;
    try {
      const body =
        typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
          ? (req.body as { items?: TestPaymentLineItem[] })
          : null;
      res.json(await createTestPaymentCheckoutSession(body));
    } catch (error) {
      if (error instanceof TestPaymentError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: 'Failed to create test payment checkout session' });
    }
  })
);

checkoutRouter.post(
  '/checkout-settle',
  asyncHandler(async (req, res) => {
    if (rejectWhenDisabled(res, { allowProductionBenchmark: true })) return;
    try {
      const body =
        typeof req.body === 'object' && req.body !== null && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      const sessionId = typeof body.checkoutSessionId === 'string' ? body.checkoutSessionId : '';
      res.json(await settleTestPaymentCheckoutSession(sessionId));
    } catch (error) {
      if (error instanceof TestPaymentError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: 'Failed to settle test payment checkout session' });
    }
  })
);
