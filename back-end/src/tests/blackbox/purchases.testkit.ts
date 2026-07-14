/**
 * Shared test infrastructure for the purchases black-box suite: assertions, card-provider
 * fakes (incl. the liveness-guard stub), a held-purchase seeder, and a Stripe call recorder.
 * Imported by purchases.blackbox.ts; not a `*.blackbox.ts` file, so it is not run as a domain.
 */
import { randomUUID } from 'node:crypto';
import { PurchaseSpendStatus } from '@prisma/client';
import { prisma } from '../../providers/database';
import { stripe } from '../../providers/stripe';
import type { CardProvider, CardProviderMintRequest } from '../../providers/card-provider';
import { AgentCardProviderError } from '../../providers/card-provider';
import type {
  WalletFundingCollectionRequest,
  WalletFundingProvider,
  WalletFundingRequest,
  WalletFundingReclaimRequest,
  WalletFundingResult,
} from '../../providers/wallet-funding';

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
  mintRequests: CardProviderMintRequest[] = [];
  detailCalls = 0;
  closeCalls = 0;
  readonly cardId = `fake-card-${randomUUID()}`;
  readonly providerTransferId = `owt_${randomUUID()}`;
  readonly pan = '4242424242424242';
  readonly cvv = '123';
  readonly expiry = '12/30';

  async mintCard(request: CardProviderMintRequest) {
    this.mintCalls += 1;
    this.mintRequests.push(request);
    return {
      cardId: this.cardId,
      last4: '4242',
      expiry: this.expiry,
      spendLimitCents: 1000,
      status: 'active',
      providerTransferId: this.providerTransferId,
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
  mintRequests: CardProviderMintRequest[] = [];
  readonly newCardId = `new-card-${randomUUID()}`;
  readonly providerTransferId = `owt_${randomUUID()}`;
  readonly newPan = '4242424242429999';
  constructor(private readonly consumedCardId: string) {}
  async mintCard(request: CardProviderMintRequest) {
    this.mintCalls += 1;
    this.mintRequests.push(request);
    return {
      cardId: this.newCardId,
      last4: this.newPan.slice(-4),
      expiry: '12/30',
      spendLimitCents: 1080,
      status: 'OPEN',
      providerTransferId: this.providerTransferId,
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

export class FailingMintCardProvider extends FakeCardProvider {
  async mintCard(): Promise<never> {
    this.mintCalls += 1;
    throw new Error('card mint failed');
  }
}

export class FailingDetailsCardProvider extends FakeCardProvider {
  async getDetails(): Promise<never> {
    this.detailCalls += 1;
    throw new Error('card details failed');
  }
}

export class FundingInProgressCardProvider extends FakeCardProvider {
  private returnedFundingGate = false;

  async mintCard(request: CardProviderMintRequest) {
    if (!this.returnedFundingGate) {
      this.returnedFundingGate = true;
      this.mintCalls += 1;
      this.mintRequests.push(request);
      throw new AgentCardProviderError(
        'AgentCard company funding is in progress',
        409,
        undefined,
        'agentcard_company_funding_in_progress',
        {
          agentcardStatus: 'funding_in_progress',
          transferId: this.providerTransferId,
          retryAfterSeconds: 0,
        }
      );
    }
    return super.mintCard(request);
  }
}

export class FakeWalletFundingProvider implements WalletFundingProvider {
  fundCalls: WalletFundingRequest[] = [];
  confirmCalls: WalletFundingCollectionRequest[] = [];
  reclaimCalls: WalletFundingReclaimRequest[] = [];
  failReclaim = false;

  async fundUserWallet(request: WalletFundingRequest): Promise<WalletFundingResult> {
    this.fundCalls.push(request);
    return {
      providerTransferId: `wft_${request.purchaseId}`,
      metadata: { ok: true, purchase_id: request.purchaseId },
    };
  }

  async confirmCollection(
    request: WalletFundingCollectionRequest
  ): Promise<WalletFundingResult> {
    this.confirmCalls.push(request);
    return {
      providerTransferId: request.providerTransferId,
      metadata: {
        ok: true,
        purchase_id: request.purchaseId,
        transfer_id: request.providerTransferId,
        outcome: request.outcome,
      },
    };
  }

  async reclaimUserWalletFunding(
    request: WalletFundingReclaimRequest
  ): Promise<WalletFundingResult> {
    this.reclaimCalls.push(request);
    if (this.failReclaim) throw new Error('wallet reclaim failed');
    return {
      providerTransferId: `wfr_${request.purchaseId}`,
      metadata: { ok: true, purchase_id: request.purchaseId, reason: request.reason },
    };
  }
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

/** Recorded Stripe side effects. `charges` holds serialized create params; the hold-lifecycle
 * arrays hold the PaymentIntent id passed to capture/cancel; `refunds` holds serialized refund
 * params. */
export interface FakeStripeCalls {
  charges: string[];
  refunds: string[];
  refundIdempotencyKeys: Array<string | undefined>;
  captures: string[];
  cancels: string[];
  retrieves: string[];
}

/**
 * Run `fn` with stripe.paymentIntents (create/capture/cancel) + refunds + customers stubbed;
 * records charge params and the hold capture/cancel/refund calls. `create` returns a stable
 * PaymentIntent id so a later capture/cancel can be tied back to the row.
 */
export async function withFakeStripe<T>(
  fn: (calls: FakeStripeCalls) => Promise<T>,
  opts: {
    retrievePaymentIntent?: (id: string) => Promise<unknown> | unknown;
    refundError?: Error;
  } = {}
) {
  const paymentIntents = stripe.paymentIntents as unknown as {
    create: (params: unknown) => Promise<{ id: string }>;
    capture: (id: string, params?: unknown) => Promise<{ id: string; status: string }>;
    cancel: (id: string, params?: unknown) => Promise<{ id: string; status: string }>;
    retrieve: (id: string) => Promise<unknown>;
  };
  const refunds = stripe.refunds as unknown as {
    create: (params: unknown, options?: { idempotencyKey?: string }) => Promise<{ id: string }>;
  };
  const customers = stripe.customers as unknown as {
    retrieve: (customerId: string) => Promise<{
      id: string;
      deleted?: boolean;
      invoice_settings: { default_payment_method: string };
    }>;
  };
  const originalPaymentIntentCreate = paymentIntents.create;
  const originalPaymentIntentCapture = paymentIntents.capture;
  const originalPaymentIntentCancel = paymentIntents.cancel;
  const originalPaymentIntentRetrieve = paymentIntents.retrieve;
  const originalRefundCreate = refunds.create;
  const originalCustomerRetrieve = customers.retrieve;
  const calls: FakeStripeCalls = {
    charges: [],
    refunds: [],
    refundIdempotencyKeys: [],
    captures: [],
    cancels: [],
    retrieves: [],
  };

  customers.retrieve = async (customerId: string) => ({
    id: customerId,
    invoice_settings: { default_payment_method: 'pm_fake_default' },
  });
  paymentIntents.create = async (params: unknown) => {
    const id = `pi_${randomUUID()}`;
    calls.charges.push(JSON.stringify(params));
    return { id };
  };
  paymentIntents.capture = async (id: string) => {
    calls.captures.push(id);
    return { id, status: 'succeeded' };
  };
  paymentIntents.cancel = async (id: string) => {
    calls.cancels.push(id);
    return { id, status: 'canceled' };
  };
  paymentIntents.retrieve = async (id: string) => {
    calls.retrieves.push(id);
    if (opts.retrievePaymentIntent !== undefined) return opts.retrievePaymentIntent(id);
    return { id, status: 'requires_capture', amount_capturable: 1000 };
  };
  refunds.create = async (params: unknown, options?: { idempotencyKey?: string }) => {
    if (opts.refundError !== undefined) throw opts.refundError;
    const id = `re_${randomUUID()}`;
    calls.refunds.push(JSON.stringify(params));
    calls.refundIdempotencyKeys.push(options?.idempotencyKey);
    return { id };
  };

  try {
    return await fn(calls);
  } finally {
    paymentIntents.create = originalPaymentIntentCreate;
    paymentIntents.capture = originalPaymentIntentCapture;
    paymentIntents.cancel = originalPaymentIntentCancel;
    paymentIntents.retrieve = originalPaymentIntentRetrieve;
    refunds.create = originalRefundCreate;
    customers.retrieve = originalCustomerRetrieve;
  }
}
