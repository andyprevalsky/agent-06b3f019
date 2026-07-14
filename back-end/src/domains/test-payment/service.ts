import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { callOrgTool } from '../../providers/agentcard/org-runtime';
import {
  AgentCardSandboxSettlementError,
  settleAgentCardSandboxPayment as settleAgentCardSandboxPaymentProvider,
  type AgentCardSandboxSettlementInput,
  type AgentCardSandboxSettlementResult,
} from '../../providers/agentcard/sandbox-settlement';
import { cleanupAgentPurchaseCards } from '../../providers/purchaseCleanup';
import { stripe } from '../../providers/stripe';
import { getPhoneBenchmarkPaymentAuditPathOverride, TEST_PAYMENT_PUBLIC_BASE_URL } from './config';
import * as testPaymentRepo from './repo';
import type {
  PhoneBenchmarkPaymentAuditEntry,
  PhoneBenchmarkPaymentInput,
  PhoneBenchmarkPaymentResult,
  TestPaymentCardInput,
  TestPaymentConfirmInput,
  TestPaymentConfirmation,
  TestPaymentItem,
  TestPaymentLineItem,
  TestPaymentLifecycle,
  TestPaymentReceiptLine,
  TestPaymentTotals,
} from './types';

const TAX_BPS = 825;
const SHIPPING_CENTS = 499;
const STRIPE_VISA_TEST_PAYMENT_METHOD = 'pm_card_visa';
const PHONE_BENCHMARK_DEFAULT_AMOUNT_CENTS = 3420;
const PHONE_BENCHMARK_DEFAULT_ITEM = 'Dozen red roses with delivery';
const DEFAULT_SANDBOX_CARDHOLDER_ID = 'cmrfpz6d1000bl804w1gggfto';

interface TestPaymentDependencies {
  settleAgentCardSandboxPayment?: (
    input: AgentCardSandboxSettlementInput
  ) => Promise<AgentCardSandboxSettlementResult>;
}

type LifecyclePurchase = Awaited<
  ReturnType<typeof testPaymentRepo.findLatestPurchaseLifecycleByAgentId>
>;
type LifecycleAttention = Awaited<
  ReturnType<typeof testPaymentRepo.findAttentionRequestsByAgentId>
>;

interface TestPaymentLifecycleDependencies {
  findPurchase?: (agentId: string) => Promise<LifecyclePurchase>;
  findAttentionRequests?: (agentId: string) => Promise<LifecycleAttention>;
  getCardSummary?: (
    userId: string,
    cardId: string
  ) => Promise<{ status: string; balanceCents: number }>;
  retrieveStripeHold?: (paymentIntentId: string) => Promise<{
    id: string;
    status: string;
    amount: number;
    amount_capturable: number;
    amount_received: number;
  }>;
  listStripeRefunds?: (paymentIntentId: string) => Promise<{
    data: Array<{ id: string; status: string | null; amount: number }>;
  }>;
  listOrgTransfers?: (args: { status?: 'consumed'; limit: number }) => Promise<unknown>;
}

export class TestPaymentError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export const TEST_PAYMENT_ITEMS: TestPaymentItem[] = [
  {
    id: 'aurora-notebook',
    name: 'Aurora Notebook',
    description: 'Hardcover planning notebook with dotted pages.',
    imageUrl: 'https://placehold.co/320x220/png?text=Aurora+Notebook',
    priceCents: 1200,
    productUrl: '/p/aurora-notebook',
    rating: '4.8 stars',
    reviewCount: '1,284 reviews',
  },
  {
    id: 'copper-pen',
    name: 'Copper Pen',
    description: 'Weighted refillable pen for precise notes.',
    imageUrl: 'https://placehold.co/320x220/png?text=Copper+Pen',
    priceCents: 700,
    productUrl: '/p/copper-pen',
    rating: '4.7 stars',
    reviewCount: '610 reviews',
  },
  {
    id: 'ceramic-mug',
    name: 'Ceramic Mug',
    description: 'Matte white mug for long checkout tests.',
    imageUrl: 'https://placehold.co/320x220/png?text=Ceramic+Mug',
    priceCents: 900,
    productUrl: '/p/ceramic-mug',
    rating: '4.6 stars',
    reviewCount: '932 reviews',
  },
  {
    id: 'canvas-tote',
    name: 'Canvas Tote',
    description: 'Heavy canvas tote with reinforced handles.',
    imageUrl: 'https://placehold.co/320x220/png?text=Canvas+Tote',
    priceCents: 1500,
    productUrl: '/p/canvas-tote',
    rating: '4.9 stars',
    reviewCount: '2,051 reviews',
  },
  {
    id: 'desk-lamp',
    name: 'Desk Lamp',
    description: 'Compact LED lamp with warm dimming.',
    imageUrl: 'https://placehold.co/320x220/png?text=Desk+Lamp',
    priceCents: 2200,
    productUrl: '/p/desk-lamp',
    rating: '4.5 stars',
    reviewCount: '1,478 reviews',
  },
];

const ITEMS_BY_ID = new Map(TEST_PAYMENT_ITEMS.map((item) => [item.id, item]));

function assertCardPresent(
  card: TestPaymentCardInput | null | undefined
): asserts card is TestPaymentCardInput {
  if (card === null || card === undefined) throw new TestPaymentError('card is required');
  if (typeof card.number !== 'string' || card.number.replace(/\s+/g, '').length < 12) {
    throw new TestPaymentError('card number is required');
  }
  if (typeof card.expiry !== 'string' || !/^\d{2}\s*\/?\s*\d{2,4}$/.test(card.expiry.trim())) {
    throw new TestPaymentError('card expiry is required');
  }
  if (typeof card.cvv !== 'string' || card.cvv.trim().length < 3) {
    throw new TestPaymentError('card cvv is required');
  }
  if (typeof card.name !== 'string' || card.name.trim() === '') {
    throw new TestPaymentError('card name is required');
  }
}

function normalizeExpiry(expiry: string): { expMonth: number; expYear: number } {
  const match = expiry.trim().match(/^(\d{2})\s*\/?\s*(\d{2}|\d{4})$/);
  if (!match) throw new TestPaymentError('card expiry is invalid');
  const expMonth = Number(match[1]);
  const rawYear = Number(match[2]);
  const expYear = rawYear < 100 ? 2000 + rawYear : rawYear;
  if (expMonth < 1 || expMonth > 12) throw new TestPaymentError('card expiry month is invalid');
  return { expMonth, expYear };
}

function isAgentCardSandboxPan(cardNumber: string): boolean {
  return /^424242424242\d{4}$/.test(cardNumber.replace(/\s+/g, ''));
}

function paymentMethodIdForBenchmarkCard(cardNumber: string): string | null {
  return isAgentCardSandboxPan(cardNumber) ? STRIPE_VISA_TEST_PAYMENT_METHOD : null;
}

function normalizeLineItems(items: TestPaymentLineItem[]): TestPaymentReceiptLine[] {
  if (!Array.isArray(items)) throw new TestPaymentError('items are required');
  if (items.length !== 3) throw new TestPaymentError('exactly 3 distinct test items are required');

  const seen = new Set<string>();
  return items.map((line) => {
    if (typeof line?.id !== 'string') throw new TestPaymentError('item id is required');
    if (seen.has(line.id)) throw new TestPaymentError('duplicate items are not allowed');
    seen.add(line.id);

    const item = ITEMS_BY_ID.get(line.id);
    if (!item) throw new TestPaymentError(`unknown item: ${line.id}`);
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity !== 1) {
      throw new TestPaymentError('each benchmark item quantity must be exactly 1');
    }
    return {
      id: item.id,
      name: item.name,
      imageUrl: item.imageUrl,
      quantity,
      unitPriceCents: item.priceCents,
      lineTotalCents: item.priceCents * quantity,
    };
  });
}

function calculateTotals(lineItems: TestPaymentReceiptLine[]): TestPaymentTotals {
  const subtotalCents = lineItems.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const taxCents = Math.round((subtotalCents * TAX_BPS) / 10_000);
  const shippingCents = SHIPPING_CENTS;
  return {
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents: subtotalCents + taxCents + shippingCents,
  };
}

export function getTestPaymentCatalog(): { items: TestPaymentItem[] } {
  return { items: TEST_PAYMENT_ITEMS };
}

export async function configureBenchmarkAgentCardSetup(input: {
  userId?: unknown;
  action?: unknown;
}): Promise<{ status: 'connect_required' | 'connected' }> {
  const userId = typeof input.userId === 'string' ? input.userId.trim() : '';
  if (userId === '') throw new TestPaymentError('userId is required');
  if (input.action === 'reset') {
    await testPaymentRepo.resetBenchmarkAgentCardSetup(userId);
    return { status: 'connect_required' };
  }
  if (input.action === 'complete') {
    const cardholderId =
      process.env.BENCHMARK_AGENTCARD_CARDHOLDER_ID?.trim() || DEFAULT_SANDBOX_CARDHOLDER_ID;
    await testPaymentRepo.completeBenchmarkAgentCardSetup(userId, cardholderId);
    return { status: 'connected' };
  }
  throw new TestPaymentError('action must be reset or complete');
}

export async function resolvePublicBaseUrl(): Promise<string | null> {
  return TEST_PAYMENT_PUBLIC_BASE_URL === '' ? null : TEST_PAYMENT_PUBLIC_BASE_URL;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function mcpResultRecord(result: unknown): Record<string, unknown> {
  const envelope = asRecord(result) ?? {};
  const structured = asRecord(envelope.toolResult) ?? asRecord(envelope.structuredContent);
  if (structured !== undefined) return structured;
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const text = content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== undefined)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
  if (text !== '') {
    const parsed = asRecord(JSON.parse(text));
    if (parsed !== undefined) return parsed;
  }
  throw new TestPaymentError('AgentCard transfer lifecycle response was invalid', 502);
}

function integerField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TestPaymentError(`AgentCard transfer lifecycle missing ${key}`, 502);
  }
  return value;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new TestPaymentError(`AgentCard transfer lifecycle missing ${key}`, 502);
  }
  return value;
}

function attentionKind(metadata: unknown): string | null {
  const value = asRecord(metadata)?.attentionKind;
  return typeof value === 'string' && value !== '' ? value : null;
}

async function getOrgCardSummary(cardId: string): Promise<{
  status: string;
  balanceCents: number;
}> {
  const result = await callOrgTool('get_card', { card_id: cardId });
  const record = mcpResultRecord(result);
  const card = asRecord(record.card) ?? record;
  const status = card.status;
  const balanceCents = card.balanceCents ?? card.balance_cents;
  if (typeof status !== 'string' || status === '') {
    throw new TestPaymentError('AgentCard card lifecycle missing status', 502);
  }
  if (typeof balanceCents !== 'number' || !Number.isInteger(balanceCents)) {
    throw new TestPaymentError('AgentCard card lifecycle missing balanceCents', 502);
  }
  return { status, balanceCents };
}

export async function getTestPaymentLifecycle(
  agentId: string,
  dependencies: TestPaymentLifecycleDependencies = {}
): Promise<TestPaymentLifecycle> {
  if (agentId.trim() === '') throw new TestPaymentError('agentId is required');
  const findPurchase =
    dependencies.findPurchase ?? testPaymentRepo.findLatestPurchaseLifecycleByAgentId;
  const findAttention =
    dependencies.findAttentionRequests ?? testPaymentRepo.findAttentionRequestsByAgentId;
  const [purchase, attentionRequests] = await Promise.all([
    findPurchase(agentId),
    findAttention(agentId),
  ]);
  if (purchase === null) {
    return {
      agentId,
      purchase: null,
      walletFunding: null,
      stripeHold: null,
      stripeRefund: null,
      agentCard: null,
      orgTransfer: null,
      attention: {
        openKinds: attentionRequests
          .filter((request) => request.userResponse === null)
          .map((request) => attentionKind(request.metadata))
          .filter((kind): kind is string => kind !== null),
        resolvedKinds: attentionRequests
          .filter((request) => request.userResponse !== null)
          .map((request) => attentionKind(request.metadata))
          .filter((kind): kind is string => kind !== null),
      },
    };
  }

  const getCardSummary =
    dependencies.getCardSummary ?? ((_userId: string, cardId: string) => getOrgCardSummary(cardId));
  const retrieveStripeHold =
    dependencies.retrieveStripeHold ??
    ((paymentIntentId: string) => stripe.paymentIntents.retrieve(paymentIntentId));
  const listOrgTransfers =
    dependencies.listOrgTransfers ?? ((args) => callOrgTool('list_transfers', args));
  const listStripeRefunds =
    dependencies.listStripeRefunds ??
    ((paymentIntentId: string) =>
      stripe.refunds.list({ payment_intent: paymentIntentId, limit: 10 }));
  const [cardDetails, stripeHold, stripeRefunds, transferResults] = await Promise.all([
    purchase.cardId ? getCardSummary(purchase.userId, purchase.cardId) : Promise.resolve(null),
    purchase.stripePaymentIntentId
      ? retrieveStripeHold(purchase.stripePaymentIntentId)
      : Promise.resolve(null),
    purchase.stripePaymentIntentId
      ? listStripeRefunds(purchase.stripePaymentIntentId)
      : Promise.resolve({ data: [] }),
    purchase.cardId
      ? Promise.all([
          listOrgTransfers({ status: 'consumed', limit: 100 }),
          listOrgTransfers({ limit: 100 }),
        ])
      : Promise.resolve([]),
  ]);
  const transfer = transferResults
    .flatMap((result) => {
      const transferRecord = mcpResultRecord(result);
      return Array.isArray(transferRecord.transfers) ? transferRecord.transfers : [];
    })
    .map((value) => asRecord(value))
    .filter((value) => value?.card_id === purchase.cardId)
    .sort((left, right) => {
      const releasedDifference =
        (typeof right?.released_cents === 'number' ? right.released_cents : 0) -
        (typeof left?.released_cents === 'number' ? left.released_cents : 0);
      if (releasedDifference !== 0) return releasedDifference;
      return right?.status === 'reclaimed' || right?.status === 'released' ? 1 : -1;
    })[0];
  const stripeRefund = stripeRefunds.data.find((refund) => refund.status === 'succeeded') ?? null;

  const kinds = attentionRequests
    .map((request) => ({
      kind: attentionKind(request.metadata),
      open: request.userResponse === null,
    }))
    .filter((entry): entry is { kind: string; open: boolean } => entry.kind !== null);
  return {
    agentId,
    purchase: {
      id: purchase.id,
      status: purchase.status,
      merchant: purchase.merchant,
      totalCents: purchase.totalCents,
      cardId: purchase.cardId,
      stripePaymentIntentId: purchase.stripePaymentIntentId,
    },
    walletFunding:
      purchase.walletFunding === null
        ? null
        : {
            status: purchase.walletFunding.status,
            amountCents: purchase.walletFunding.amountCents,
            providerTransferId: purchase.walletFunding.providerTransferId,
            reclaimProviderTransferId: purchase.walletFunding.reclaimProviderTransferId,
          },
    stripeHold:
      stripeHold === null
        ? null
        : {
            id: stripeHold.id,
            status: stripeHold.status,
            amountCents: stripeHold.amount,
            amountCapturableCents: stripeHold.amount_capturable,
            amountReceivedCents: stripeHold.amount_received,
          },
    stripeRefund:
      stripeRefund === null
        ? null
        : {
            id: stripeRefund.id,
            status: stripeRefund.status ?? 'unknown',
            amountCents: stripeRefund.amount,
          },
    agentCard:
      cardDetails === null || purchase.cardId === null
        ? null
        : {
            id: purchase.cardId,
            status: cardDetails.status,
            balanceCents: cardDetails.balanceCents,
          },
    orgTransfer:
      transfer === undefined
        ? null
        : {
            id: stringField(transfer, 'id'),
            status: stringField(transfer, 'status'),
            amountCents: integerField(transfer, 'amount_cents'),
            transferredCents: integerField(transfer, 'transferred_cents'),
            releasedCents: integerField(transfer, 'released_cents'),
            cardId: typeof transfer.card_id === 'string' ? transfer.card_id : null,
            livemode: transfer.livemode === true,
          },
    attention: {
      openKinds: kinds.filter((entry) => entry.open).map((entry) => entry.kind),
      resolvedKinds: kinds.filter((entry) => !entry.open).map((entry) => entry.kind),
    },
  };
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
