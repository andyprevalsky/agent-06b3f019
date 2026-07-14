import type { TestPaymentCardForm, TestPaymentItem } from './types';

export const TEST_PAYMENT_MERCHANT_NAME = 'Rose Labs Test Payment';
export const REQUIRED_ITEM_IDS = ['aurora-notebook', 'ceramic-mug', 'canvas-tote'] as const;
export const LIVE_LIFECYCLE_BENCHMARK_QUERY = 'agentcard-live-lifecycle';
export const ABANDONMENT_BENCHMARK_QUERY = 'agentcard-abandonment';
export const ABANDONMENT_BENCHMARK_ITEMS: TestPaymentItem[] = [
  {
    id: 'aurora-notebook',
    name: 'Aurora Notebook',
    description: 'Hardcover planning notebook with dotted pages.',
    imageUrl: 'https://placehold.co/320x220/png?text=Aurora+Notebook',
    priceCents: 1200,
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
];
export const LIVE_LIFECYCLE_ITEM: TestPaymentItem = {
  id: 'agentcard-lifecycle-probe',
  name: 'Agent Card Lifecycle Probe',
  description: 'Single-use checkout verification item.',
  imageUrl: 'https://placehold.co/320x220/png?text=Agent+Card+Lifecycle+Probe',
  priceCents: 50,
};

export const EMPTY_CARD_FORM: TestPaymentCardForm = {
  name: '',
  number: '',
  expiry: '',
  cvv: '',
  postalCode: '94105',
};

export const TAX_LABEL = 'Tax';
export const SHIPPING_LABEL = 'Shipping';
