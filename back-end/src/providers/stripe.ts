/**
 * Canonical Stripe SDK provider.
 * Domain code must import from here instead of 'stripe' directly.
 * ESLint no-restricted-imports enforces this in src/domains/.
 */
import Stripe from 'stripe';

const STRIPE_API_VERSION = '2025-02-24.acacia' as const;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? '';

export const stripe = new Stripe(STRIPE_SECRET_KEY, {
  apiVersion: STRIPE_API_VERSION,
});

export type { Stripe };
