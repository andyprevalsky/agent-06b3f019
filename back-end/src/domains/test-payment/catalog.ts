import { TestPaymentError } from './errors';
import type {
  TestPaymentCardInput,
  TestPaymentItem,
  TestPaymentLineItem,
  TestPaymentReceiptLine,
  TestPaymentTotals,
} from './types';

const TAX_BPS = 825;
const SHIPPING_CENTS = 499;
const STRIPE_VISA_TEST_PAYMENT_METHOD = 'pm_card_visa';
const LIVE_LIFECYCLE_ITEM_ID = 'agentcard-lifecycle-probe';

const LIVE_LIFECYCLE_ITEM: TestPaymentItem = {
  id: LIVE_LIFECYCLE_ITEM_ID,
  name: 'Agent Card Lifecycle Probe',
  description: 'Single-use checkout verification item.',
  imageUrl: 'https://placehold.co/320x220/png?text=Agent+Card+Lifecycle+Probe',
  priceCents: 100,
  productUrl: '/p/agentcard-lifecycle-probe',
  rating: '5.0 stars',
  reviewCount: '128 reviews',
};

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

const CHECKOUT_ITEMS_BY_ID = new Map(
  [...TEST_PAYMENT_ITEMS, LIVE_LIFECYCLE_ITEM].map((item) => [item.id, item])
);

export function assertCardPresent(
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

export function normalizeExpiry(expiry: string): { expMonth: number; expYear: number } {
  const match = expiry.trim().match(/^(\d{2})\s*\/?\s*(\d{2}|\d{4})$/);
  if (!match) throw new TestPaymentError('card expiry is invalid');
  const expMonth = Number(match[1]);
  const rawYear = Number(match[2]);
  const expYear = rawYear < 100 ? 2000 + rawYear : rawYear;
  if (expMonth < 1 || expMonth > 12) throw new TestPaymentError('card expiry month is invalid');
  return { expMonth, expYear };
}

export function isAgentCardSandboxPan(cardNumber: string): boolean {
  return /^424242424242\d{4}$/.test(cardNumber.replace(/\s+/g, ''));
}

export function paymentMethodIdForBenchmarkCard(cardNumber: string): string | null {
  return isAgentCardSandboxPan(cardNumber) ? STRIPE_VISA_TEST_PAYMENT_METHOD : null;
}

export function normalizeLineItems(items: TestPaymentLineItem[]): TestPaymentReceiptLine[] {
  if (!Array.isArray(items)) throw new TestPaymentError('items are required');
  const isLiveLifecycleCart = items.length === 1 && items[0]?.id === LIVE_LIFECYCLE_ITEM_ID;
  if (!isLiveLifecycleCart && items.length !== 3) {
    throw new TestPaymentError(
      'exactly 3 distinct test items or the single lifecycle probe are required'
    );
  }

  const seen = new Set<string>();
  return items.map((line) => {
    if (typeof line?.id !== 'string') throw new TestPaymentError('item id is required');
    if (seen.has(line.id)) throw new TestPaymentError('duplicate items are not allowed');
    seen.add(line.id);

    const item = CHECKOUT_ITEMS_BY_ID.get(line.id);
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

export function calculateTotals(lineItems: TestPaymentReceiptLine[]): TestPaymentTotals {
  const subtotalCents = lineItems.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const isLiveLifecycleCart = lineItems.length === 1 && lineItems[0]?.id === LIVE_LIFECYCLE_ITEM_ID;
  const taxCents = isLiveLifecycleCart ? 0 : Math.round((subtotalCents * TAX_BPS) / 10_000);
  const shippingCents = isLiveLifecycleCart ? 0 : SHIPPING_CENTS;
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
