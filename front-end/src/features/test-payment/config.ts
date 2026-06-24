import type { TestPaymentCardForm } from './types';

export const TEST_PAYMENT_MERCHANT_NAME = 'Rose Labs Test Payment';
export const REQUIRED_ITEM_IDS = ['aurora-notebook', 'ceramic-mug', 'canvas-tote'] as const;

export const EMPTY_CARD_FORM: TestPaymentCardForm = {
  name: '',
  number: '',
  expiry: '',
  cvv: '',
  postalCode: '94105',
};

export const TAX_LABEL = 'Tax';
export const SHIPPING_LABEL = 'Shipping';
