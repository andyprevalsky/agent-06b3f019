import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentCardSandboxSettlementError,
  settleAgentCardSandboxPayment as settleAgentCardSandboxPaymentProvider,
  type AgentCardSandboxSettlementInput,
  type AgentCardSandboxSettlementResult,
} from '../../providers/agentcard/sandbox-settlement';
import { getOrgCardholderVerificationStatus } from '../../providers/agentcard/org-onboarding';
import { cleanupAgentPurchaseCards } from '../../providers/purchaseCleanup';
import { stripe } from '../../providers/stripe';
import {
  assertCardPresent,
  calculateTotals,
  isAgentCardSandboxPan,
  normalizeExpiry,
  normalizeLineItems,
  paymentMethodIdForBenchmarkCard,
} from './catalog';
import {
  getBenchmarkAgentCardCardholderIdOverride,
  getPhoneBenchmarkPaymentAuditPathOverride,
  TEST_PAYMENT_PUBLIC_BASE_URL,
} from './config';
import { TestPaymentError } from './errors';
import { getTestPaymentLifecycle } from './lifecycle';
import * as testPaymentRepo from './repo';
import type {
  PhoneBenchmarkPaymentAuditEntry,
  PhoneBenchmarkPaymentInput,
  PhoneBenchmarkPaymentResult,
  TestPaymentConfirmInput,
  TestPaymentConfirmation,
  TestPaymentLifecycle,
} from './types';

export { TEST_PAYMENT_ITEMS, getTestPaymentCatalog } from './catalog';
export { TestPaymentError } from './errors';
export { getTestPaymentLifecycle } from './lifecycle';
export type { TestPaymentLifecycleDependencies } from './lifecycle';
export { findAgentOwnerId } from './repo';

const PHONE_BENCHMARK_DEFAULT_AMOUNT_CENTS = 3420;
const PHONE_BENCHMARK_DEFAULT_ITEM = 'Dozen red roses with delivery';
const DEFAULT_SANDBOX_CARDHOLDER_ID = 'cmrfpz6d1000bl804w1gggfto';

interface TestPaymentDependencies {
  settleAgentCardSandboxPayment?: (
    input: AgentCardSandboxSettlementInput
  ) => Promise<AgentCardSandboxSettlementResult>;
  getCardholderVerificationStatus?: (cardholderId: string) => Promise<string>;
}

export async function configureBenchmarkAgentCardSetup(
  input: {
    userId?: unknown;
    action?: unknown;
  },
  dependencies: TestPaymentDependencies = {}
): Promise<{ status: 'connect_required' | 'connected' }> {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (userId === '') throw new TestPaymentError('userId is required');
  if (input.action === 'reset') {
    await testPaymentRepo.resetBenchmarkAgentCardSetup(userId);
    return { status: 'connect_required' };
  }
  if (input.action === 'complete') {
    const cardholderId =
      getBenchmarkAgentCardCardholderIdOverride() || DEFAULT_SANDBOX_CARDHOLDER_ID;
    const orgOAuthConfigured =
      (process.env.AGENTCARD_ORG_OAUTH_CLIENT_ID ?? '').trim() !== '' &&
      (process.env.AGENTCARD_ORG_OAUTH_CLIENT_SECRET ?? '').trim() !== '';
    const getVerificationStatus =
      dependencies.getCardholderVerificationStatus ??
      (orgOAuthConfigured ? getOrgCardholderVerificationStatus : undefined);
    if (getVerificationStatus !== undefined) {
      let verificationStatus: string;
      try {
        verificationStatus = await getVerificationStatus(cardholderId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TestPaymentError(
          `Benchmark AgentCard cardholder readiness check failed: ${message}`,
          502
        );
      }
      if (verificationStatus !== 'verified' && verificationStatus !== 'approved') {
        throw new TestPaymentError(
          `Benchmark AgentCard cardholder is not ready (${verificationStatus})`,
          409
        );
      }
    }
    await testPaymentRepo.completeBenchmarkAgentCardSetup(userId, cardholderId);
    return { status: 'connected' };
  }
  throw new TestPaymentError('action must be reset or complete');
}

export async function resolvePublicBaseUrl(): Promise<string | null> {
  return TEST_PAYMENT_PUBLIC_BASE_URL === '' ? null : TEST_PAYMENT_PUBLIC_BASE_URL;
}

export async function abandonTestPayment(agentId: string): Promise<TestPaymentLifecycle> {
  if (agentId.trim() === '') throw new TestPaymentError('agentId is required');
  await cleanupAgentPurchaseCards(agentId);
  return getTestPaymentLifecycle(agentId);
}

export async function confirmTestPayment(
  input: TestPaymentConfirmInput,
  dependencies: TestPaymentDependencies = {}
): Promise<TestPaymentConfirmation> {
  const lineItems = normalizeLineItems(input.items);
  assertCardPresent(input.card);
  const totals = calculateTotals(lineItems);
  const { expMonth, expYear } = normalizeExpiry(input.card.expiry);
  const normalizedCardNumber = input.card.number.replace(/\s+/g, '');
  const postalCode = input.card.postalCode?.trim();

  if (isAgentCardSandboxPan(normalizedCardNumber)) {
    const settle = dependencies.settleAgentCardSandboxPayment ?? settleAgentCardSandboxPayment;
    const settlement = await settle({
      cardNumber: normalizedCardNumber,
      amountCents: totals.totalCents,
      merchant: 'Rose Labs Test Payment',
    });
    return {
      orderId: `tp_${randomUUID().slice(0, 8)}`,
      status: 'succeeded',
      paymentIntentId: settlement.stripePaymentIntentId,
      purchaseId: settlement.purchaseId,
      cardId: settlement.cardId,
      receipt: { lineItems, totals },
    };
  }

  const paymentMethodId = (
    await stripe.paymentMethods.create({
      type: 'card',
      card: {
        number: normalizedCardNumber,
        exp_month: expMonth,
        exp_year: expYear,
        cvc: input.card.cvv.trim(),
      },
      billing_details: {
        name: input.card.name.trim(),
        address:
          postalCode === undefined || postalCode === '' ? undefined : { postal_code: postalCode },
      },
    })
  ).id;

  const paymentIntent = await stripe.paymentIntents.create({
    amount: totals.totalCents,
    currency: 'usd',
    payment_method: paymentMethodId,
    payment_method_types: ['card'],
    confirm: true,
    metadata: {
      testPayment: 'true',
      itemIds: lineItems.map((item) => item.id).join(','),
    },
  });

  if (paymentIntent.status !== 'succeeded') {
    throw new TestPaymentError(`Stripe test payment did not succeed: ${paymentIntent.status}`, 402);
  }

  return {
    orderId: `tp_${randomUUID().slice(0, 8)}`,
    status: paymentIntent.status,
    paymentIntentId: paymentIntent.id,
    receipt: { lineItems, totals },
  };
}

async function settleAgentCardSandboxPayment(
  input: AgentCardSandboxSettlementInput
): Promise<AgentCardSandboxSettlementResult> {
  try {
    return await settleAgentCardSandboxPaymentProvider(input);
  } catch (error) {
    if (error instanceof AgentCardSandboxSettlementError) {
      throw new TestPaymentError(error.message, error.statusCode);
    }
    throw error;
  }
}

function normalizePhoneBenchmarkPaymentInput(
  input: PhoneBenchmarkPaymentInput
): Required<PhoneBenchmarkPaymentInput> {
  const cardNumber = String(input.cardNumber ?? '').replace(/\s+/g, '');
  const expiration = String(input.expiration ?? '').trim();
  const cvc = String(input.cvc ?? '').trim();
  const billingZip = String(input.billingZip ?? '').trim();
  const trimmedCardholderName = String(input.cardholderName ?? 'Rose Labs').trim();
  const cardholderName = trimmedCardholderName === '' ? 'Rose Labs' : trimmedCardholderName;
  const amountCents = Number(input.amountCents ?? PHONE_BENCHMARK_DEFAULT_AMOUNT_CENTS);
  const trimmedOrderItem = String(input.orderItem ?? PHONE_BENCHMARK_DEFAULT_ITEM).trim();
  const orderItem = trimmedOrderItem === '' ? PHONE_BENCHMARK_DEFAULT_ITEM : trimmedOrderItem;

  if (cardNumber.length < 12) throw new TestPaymentError('cardNumber is required');
  normalizeExpiry(expiration);
  if (cvc.length < 3) throw new TestPaymentError('cvc is required');
  if (billingZip.length < 5) throw new TestPaymentError('billingZip is required');
  if (!Number.isInteger(amountCents) || amountCents !== PHONE_BENCHMARK_DEFAULT_AMOUNT_CENTS) {
    throw new TestPaymentError('amountCents must be 3420 for the phone payment benchmark');
  }

  return { cardNumber, expiration, cvc, billingZip, cardholderName, amountCents, orderItem };
}

export async function confirmPhoneBenchmarkPayment(
  input: PhoneBenchmarkPaymentInput
): Promise<PhoneBenchmarkPaymentResult> {
  const normalized = normalizePhoneBenchmarkPaymentInput(input);
  const { expMonth, expYear } = normalizeExpiry(normalized.expiration);
  const knownTestPaymentMethod = paymentMethodIdForBenchmarkCard(normalized.cardNumber);
  const paymentMethodId =
    knownTestPaymentMethod ??
    (
      await stripe.paymentMethods.create({
        type: 'card',
        card: {
          number: normalized.cardNumber,
          exp_month: expMonth,
          exp_year: expYear,
          cvc: normalized.cvc,
        },
        billing_details: {
          name: normalized.cardholderName,
          address: { postal_code: normalized.billingZip },
        },
      })
    ).id;

  const paymentIntent = await stripe.paymentIntents.create({
    amount: normalized.amountCents,
    currency: 'usd',
    payment_method: paymentMethodId,
    payment_method_types: ['card'],
    confirm: true,
    metadata: {
      benchmark: 'phone-call-payment',
      orderItem: normalized.orderItem,
      billingZip: normalized.billingZip,
    },
  });

  if (paymentIntent.status !== 'succeeded') {
    throw new TestPaymentError(
      `Stripe phone benchmark payment did not succeed: ${paymentIntent.status}`,
      402
    );
  }

  return {
    status: paymentIntent.status,
    paymentIntentId: paymentIntent.id,
    amountCents: normalized.amountCents,
    total: '$34.20',
    orderItem: normalized.orderItem,
    confirmationCode: 'ROSE-4471',
    cardLastFour: normalized.cardNumber.slice(-4),
  };
}

export function phoneBenchmarkPaymentAuditPath(): string {
  const auditPathOverride = getPhoneBenchmarkPaymentAuditPathOverride();
  return auditPathOverride !== ''
    ? path.resolve(auditPathOverride)
    : path.resolve(process.cwd(), '..', '.context', 'phone-benchmark-payments.jsonl');
}

export async function recordPhoneBenchmarkPaymentAudit(
  entry: Omit<PhoneBenchmarkPaymentAuditEntry, 'createdAt'>
): Promise<PhoneBenchmarkPaymentAuditEntry> {
  const fullEntry: PhoneBenchmarkPaymentAuditEntry = {
    createdAt: new Date().toISOString(),
    ...entry,
  };
  const auditPath = phoneBenchmarkPaymentAuditPath();
  await mkdir(path.dirname(auditPath), { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(fullEntry)}\n`, 'utf8');
  return fullEntry;
}
