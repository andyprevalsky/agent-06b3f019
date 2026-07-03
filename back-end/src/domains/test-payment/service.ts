import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { stripe } from '../../providers/stripe';
import { getPhoneBenchmarkPaymentAuditPathOverride, TEST_PAYMENT_PUBLIC_BASE_URL } from './config';
import type {
  PhoneBenchmarkPaymentAuditEntry,
  PhoneBenchmarkPaymentInput,
  PhoneBenchmarkPaymentResult,
  TestPaymentCardInput,
  TestPaymentConfirmInput,
  TestPaymentConfirmation,
  TestPaymentItem,
  TestPaymentLineItem,
  TestPaymentReceiptLine,
  TestPaymentTotals,
} from './types';

const TAX_BPS = 825;
const SHIPPING_CENTS = 499;
const STRIPE_VISA_TEST_PAYMENT_METHOD = 'pm_card_visa';
const PHONE_BENCHMARK_DEFAULT_AMOUNT_CENTS = 3420;
const PHONE_BENCHMARK_DEFAULT_ITEM = 'Dozen red roses with delivery';

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
  },
  {
    id: 'copper-pen',
    name: 'Copper Pen',
    description: 'Weighted refillable pen for precise notes.',
    imageUrl: 'https://placehold.co/320x220/png?text=Copper+Pen',
    priceCents: 700,
  },
  {
    id: 'ceramic-mug',
    name: 'Ceramic Mug',
    description: 'Matte white mug for long checkout tests.',
    imageUrl: 'https://placehold.co/320x220/png?text=Ceramic+Mug',
    priceCents: 900,
  },
  {
    id: 'canvas-tote',
    name: 'Canvas Tote',
    description: 'Heavy canvas tote with reinforced handles.',
    imageUrl: 'https://placehold.co/320x220/png?text=Canvas+Tote',
    priceCents: 1500,
  },
  {
    id: 'desk-lamp',
    name: 'Desk Lamp',
    description: 'Compact LED lamp with warm dimming.',
    imageUrl: 'https://placehold.co/320x220/png?text=Desk+Lamp',
    priceCents: 2200,
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

export async function resolvePublicBaseUrl(): Promise<string | null> {
  return TEST_PAYMENT_PUBLIC_BASE_URL === '' ? null : TEST_PAYMENT_PUBLIC_BASE_URL;
}

export async function confirmTestPayment(
  input: TestPaymentConfirmInput
): Promise<TestPaymentConfirmation> {
  const lineItems = normalizeLineItems(input.items);
  assertCardPresent(input.card);
  const totals = calculateTotals(lineItems);
  const { expMonth, expYear } = normalizeExpiry(input.card.expiry);
  const normalizedCardNumber = input.card.number.replace(/\s+/g, '');
  const postalCode = input.card.postalCode?.trim();

  const paymentMethodId = isAgentCardSandboxPan(normalizedCardNumber)
    ? (paymentMethodIdForBenchmarkCard(normalizedCardNumber) ?? STRIPE_VISA_TEST_PAYMENT_METHOD)
    : (
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
              postalCode === undefined || postalCode === ''
                ? undefined
                : { postal_code: postalCode },
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
