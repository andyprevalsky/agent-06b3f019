import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  AgentCardSandboxSettlementError,
  settleAgentCardSandboxPayment as settleAgentCardSandboxPaymentProvider,
  type AgentCardSandboxSettlementInput,
  type AgentCardSandboxSettlementResult,
} from '../../providers/agentcard/sandbox-settlement';
import { validateV2SandboxFixtureUser } from '../../providers/agentcard/v2-onboarding';
import { saveV2ConnectedUserId } from '../../providers/agentcard/store';
import type { AgentCardV2Request } from '../../providers/agentcard/api-v2';
import { nonLocalDatabaseReason } from '../../utils/localDatabaseUrl';
import { cleanupAgentPurchaseCards } from '../../providers/purchaseCleanup';
import { stripe } from '../../providers/stripe';
import {
  assertCardPresent,
  calculateTotals,
  normalizeExpiry,
  normalizeLineItems,
  paymentMethodIdForBenchmarkCard,
} from './catalog';
import type { BenchmarkResidualDependencies } from './benchmarkResidual';
import {
  getPhoneBenchmarkPaymentAuditPathOverride,
  getBenchmarkV2FixtureUserId,
  getSandboxFixtureDatabaseUrl,
  isProductionEnv,
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

interface TestPaymentDependencies extends BenchmarkResidualDependencies {
  settleAgentCardSandboxPayment?: (
    input: AgentCardSandboxSettlementInput
  ) => Promise<AgentCardSandboxSettlementResult>;
  getV2FixtureUserId?: () => string | undefined;
  v2Request?: AgentCardV2Request;
  /** Override live list_cardholders resolution (unit tests / offline fixtures). */
  resolveCardholderId?: () => Promise<string>;
}

export async function configureBenchmarkAgentCardSetup(
  input: {
    userId?: unknown;
    action?: unknown;
  },
  dependencies: TestPaymentDependencies = {}
): Promise<{ status: 'connect_required' | 'connected' | 'residual_ready' }> {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (userId === '') throw new TestPaymentError('userId is required');
  if (
    input.action === 'reset' ||
    input.action === 'complete' ||
    input.action === 'prepare-residual'
  ) {
    if (isProductionEnv() || nonLocalDatabaseReason(getSandboxFixtureDatabaseUrl()) !== null)
      throw new TestPaymentError(
        'Sandbox AgentCard setup unavailable outside a local non-production database',
        403
      );
    const providerUserId = (dependencies.getV2FixtureUserId ?? getBenchmarkV2FixtureUserId)();
    if (providerUserId === undefined || providerUserId.trim() === '') {
      throw new TestPaymentError(
        'BENCHMARK_AGENTCARD_V2_USER_ID is required; complete the signed sandbox connection first. Legacy cardholderId is not a v2 identity.',
        409
      );
    }
    await validateV2SandboxFixtureUser(providerUserId, dependencies.v2Request);
    // v2 company-funded issuance uses organization transfers; there is no MCP
    // cardholder headroom to sweep. Legacy recovery remains in benchmarkResidual.
    if (input.action === 'prepare-residual') return { status: 'residual_ready' };
    if (input.action === 'reset') {
      await testPaymentRepo.resetBenchmarkAgentCardSetup(userId);
      return { status: 'connect_required' };
    }
    await saveV2ConnectedUserId(userId, providerUserId);
    return { status: 'connected' };
  }
  throw new TestPaymentError('action must be reset, complete, or prepare-residual');
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

  // Route by OWNERSHIP, not by BIN. `isAgentCardSandboxPan` only matched the
  // 424242424242xxxx sandbox BIN, so a LIVE Rose-minted card (real Visa BIN) fell through to the
  // raw-PAN Stripe path — which Stripe blocks in live mode (PCI). Settlement already proves
  // ownership itself: it matches the typed PAN against the minted card on a HELD purchase and
  // throws 404 when nothing matches. So attempt it for any PAN and fall through only on that 404,
  // which keeps genuine third-party cards on the Stripe path while letting a live Rose card settle.
  const settle = dependencies.settleAgentCardSandboxPayment ?? settleAgentCardSandboxPayment;
  let roseCardSettlement: Awaited<ReturnType<typeof settleAgentCardSandboxPayment>> | null = null;
  try {
    roseCardSettlement = await settle({
      cardNumber: normalizedCardNumber,
      amountCents: totals.totalCents,
      merchant: 'Rose Labs Test Payment',
    });
    return {
      orderId: `tp_${randomUUID().slice(0, 8)}`,
      status: 'succeeded',
      paymentIntentId: roseCardSettlement.stripePaymentIntentId,
      purchaseId: roseCardSettlement.purchaseId,
      cardId: roseCardSettlement.cardId,
      receipt: { lineItems, totals },
    };
  } catch (error) {
    // 404 = this PAN is not a Rose-minted card on a HELD purchase, so it is an ordinary shopper
    // card and belongs on the Stripe path below. Every other failure is a REAL settlement fault
    // (wrong amount, missing hold, charge declined) and must surface instead of silently
    // re-charging the customer through a second provider.
    // The local wrapper above rewraps AgentCardSandboxSettlementError as TestPaymentError, keeping
    // the status code, so match on that — an injected test double may still raise the raw provider
    // error, so accept either.
    const notARoseCard =
      (error instanceof TestPaymentError || error instanceof AgentCardSandboxSettlementError) &&
      error.statusCode === 404;
    if (!notARoseCard) throw error;
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
