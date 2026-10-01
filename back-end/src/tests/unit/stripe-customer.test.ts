#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { config } from 'dotenv';

async function main(): Promise<void> {
  config();
  const { getCustomerDefaultPaymentMethodId } =
    await import('../../domains/purchases/stripeCustomer');
  const { stripe } = await import('../../providers/stripe');
  const customers = stripe.customers as unknown as { retrieve: (id: string) => Promise<unknown> };
  const subscriptions = stripe.subscriptions as unknown as {
    retrieve: (id: string) => Promise<unknown>;
  };
  const originalCustomer = customers.retrieve;
  const originalSubscription = subscriptions.retrieve;
  try {
    customers.retrieve = async (id) => ({ id, invoice_settings: {} });
    subscriptions.retrieve = async () => {
      throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
    };
    await assert.rejects(
      getCustomerDefaultPaymentMethodId('cus_test', 'sub_deleted'),
      /default Stripe payment method/
    );

    subscriptions.retrieve = async () => {
      throw Object.assign(new Error('Stripe unavailable'), { code: 'api_error' });
    };
    await assert.rejects(
      getCustomerDefaultPaymentMethodId('cus_test', 'sub_unavailable'),
      /Stripe unavailable/
    );
  } finally {
    customers.retrieve = originalCustomer;
    subscriptions.retrieve = originalSubscription;
  }
}

void main();
