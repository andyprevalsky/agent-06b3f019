/**
 * Shared test infrastructure for the purchases black-box suite: assertions, card-provider
 * fakes (incl. the liveness-guard stub), a held-purchase seeder, and a Stripe call recorder.
 * Imported by purchases.blackbox.ts; not a `*.blackbox.ts` file, so it is not run as a domain.
 */
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { stripe } from '../../providers/stripe';
import type { CardProvider } from '../../providers/card-provider';

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function assertStatus(actual: number, expected: number, data: unknown): void {
  if (actual !== expected) {
    throw new Error(`Expected status ${expected}, got ${actual}: ${JSON.stringify(data)}`);
  }
}

export class FakeCardProvider implements CardProvider {
  mintCalls = 0;
  detailCalls = 0;
  closeCalls = 0;
  readonly cardId = `fake-card-${randomUUID()}`;
  readonly pan = '4242424242424242';
  readonly cvv = '123';
  readonly expiry = '12/30';

  async mintCard() {
    this.mintCalls += 1;
    return {
      cardId: this.cardId,
      last4: '4242',
      expiry: this.expiry,
      spendLimitCents: 1000,
      status: 'active',
    };
  }

  async getDetails(cardId: string) {
    this.detailCalls += 1;
    assert(cardId === this.cardId, `unexpected card id ${cardId}`);
    return {
      pan: this.pan,
      cvv: this.cvv,
      expiry: this.expiry,
      balanceCents: 1000,
      status: 'active',
    };
  }

  async closeCard(cardId: string) {
    this.closeCalls += 1;
    assert(cardId === this.cardId, `unexpected card id ${cardId}`);
  }
}

/**
 * Provider whose getDetails reports a fixed card state for ANY card id — used to exercise the
 * webhook-independent liveness guard (a card the network has already settled reports
 * status CLOSED / balanceCents 0).
 */
export class StubCardStateProvider implements CardProvider {
  getDetailsCalls = 0;
  constructor(private readonly state: { status: string; balanceCents: number; pan?: string }) {}
  async mintCard(): Promise<never> {
    throw new Error('StubCardStateProvider.mintCard should not be called');
  }
  async getDetails(_cardId: string) {
    this.getDetailsCalls += 1;
    return {
      pan: this.state.pan ?? '4242424242424242',
      cvv: '123',
      expiry: '12/30',
      balanceCents: this.state.balanceCents,
      status: this.state.status,
    };
  }
  async closeCard(): Promise<void> {}
}

/**
 * Provider for the re-purchase path: reports a specific (already-consumed) card as CLOSED/0 but
 * mints a fresh live card for the new purchase.
 */
export class RepurchaseProvider implements CardProvider {
  mintCalls = 0;
  readonly newCardId = `new-card-${randomUUID()}`;
  readonly newPan = '4242424242429999';
  constructor(private readonly consumedCardId: string) {}
  async mintCard() {
    this.mintCalls += 1;
    return {
      cardId: this.newCardId,
      last4: this.newPan.slice(-4),
      expiry: '12/30',
      spendLimitCents: 1080,
      status: 'OPEN',
    };
  }
  async getDetails(cardId: string) {
    if (cardId === this.consumedCardId) {
      return {
        pan: '4242424242420000',
        cvv: '123',
        expiry: '12/30',
        balanceCents: 0,
        status: 'CLOSED',
      };
    }
    return { pan: this.newPan, cvv: '123', expiry: '12/30', balanceCents: 1080, status: 'OPEN' };
  }
  async closeCard(): Promise<void> {}
}

export async function seedHeldPurchase(userId: string, fingerprint: string, cardId: string) {
  return prisma.purchaseSpend.create({
    data: {
      userId,
      fingerprint,
      merchant: 'Test Merchant',
      lineItemsJson: { currency: 'usd', lineItems: [], totalCents: 1080 },
      totalCents: 1080,
      status: PurchaseSpendStatus.HELD,
      cardId,
      stripePaymentIntentId: `pi_seed_${randomUUID()}`,
    },
  });
}

/** Run `fn` with stripe.paymentIntents/refunds/customers stubbed; records charge/refund params. */
export async function withFakeStripe<T>(
  fn: (calls: { charges: string[]; refunds: string[] }) => Promise<T>
) {
  const paymentIntents = stripe.paymentIntents as unknown as {
    create: (params: unknown) => Promise<{ id: string }>;
  };
  const refunds = stripe.refunds as unknown as {
    create: (params: unknown) => Promise<{ id: string }>;
  };
  const customers = stripe.customers as unknown as {
    retrieve: (customerId: string) => Promise<{
      id: string;
      deleted?: boolean;
      invoice_settings: { default_payment_method: string };
    }>;
  };
  const originalPaymentIntentCreate = paymentIntents.create;
  const originalRefundCreate = refunds.create;
  const originalCustomerRetrieve = customers.retrieve;
  const calls = { charges: [] as string[], refunds: [] as string[] };

  customers.retrieve = async (customerId: string) => ({
    id: customerId,
    invoice_settings: { default_payment_method: 'pm_fake_default' },
  });
  paymentIntents.create = async (params: unknown) => {
    const id = `pi_${randomUUID()}`;
    calls.charges.push(JSON.stringify(params));
    return { id };
  };
  refunds.create = async (params: unknown) => {
    const id = `re_${randomUUID()}`;
    calls.refunds.push(JSON.stringify(params));
    return { id };
  };

  try {
    return await fn(calls);
  } finally {
    paymentIntents.create = originalPaymentIntentCreate;
    refunds.create = originalRefundCreate;
    customers.retrieve = originalCustomerRetrieve;
  }
}
