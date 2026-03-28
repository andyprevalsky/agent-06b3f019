/**
 * Billing API Routes
 * Stripe billing portal for subscription management
 */

import express, { Response } from 'express';
import Stripe from 'stripe';
import { authenticate, AuthRequest } from '../providers/auth';
import { prisma } from '../providers/database';

const router = express.Router();

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2025-02-24.acacia',
});

/**
 * GET /api/billing/portal
 * Returns a Stripe Customer Portal URL for the authenticated user
 * User can manage subscriptions, payment methods, and view invoices
 */
router.get('/portal', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userId = req.user.id;

    // Get user's subscription to find their Stripe customer ID
    const subscription = await prisma.subscription.findUnique({
      where: { userId },
    });

    if (!subscription || !subscription.stripeCustomerId) {
      return res.status(404).json({
        error: 'No subscription found',
        message: 'You need an active subscription to access the billing portal.',
      });
    }

    // Determine return URL based on environment
    const isProduction = process.env.NODE_ENV === 'production';
    const returnUrl = isProduction
      ? 'https://roselabs.ai/settings'
      : 'http://localhost:5173/settings';

    // Create a billing portal session
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: returnUrl,
    });

    res.json({ url: portalSession.url });
  } catch (error) {
    console.error('Error creating billing portal session:', error);
    res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

export default router;
