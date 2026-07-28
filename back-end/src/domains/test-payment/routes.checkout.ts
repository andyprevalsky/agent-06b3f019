/**
 * Hosted Stripe Checkout endpoints for /test_payment — the real-merchant path that lets a LIVE
 * Rose-minted AgentCard actually be authorized (AgentCard's `test_charge` is sandbox-only).
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
      res.json(
        await createTestPaymentCheckoutSession(req.body as { items: TestPaymentLineItem[] })
      );
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
      const body = req.body as Record<string, unknown>;
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
