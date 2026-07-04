/* c8 ignore start -- Type-only declarations; no runtime code to cover. */

export interface TestPaymentItem {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  priceCents: number;
}

export interface TestPaymentLineItem {
  id: string;
  quantity: number;
}

export interface TestPaymentCardInput {
  number: string;
  expiry: string;
  cvv: string;
  name: string;
  postalCode?: string;
}

export interface TestPaymentConfirmInput {
  items: TestPaymentLineItem[];
  card: TestPaymentCardInput;
}

export interface TestPaymentReceiptLine {
  id: string;
  name: string;
  imageUrl: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface TestPaymentTotals {
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
}

export interface TestPaymentConfirmation {
  orderId: string;
  status: string;
  paymentIntentId: string;
  receipt: {
    lineItems: TestPaymentReceiptLine[];
    totals: TestPaymentTotals;
  };
}

export interface PhoneBenchmarkPaymentInput {
  cardNumber: string;
  expiration: string;
  cvc: string;
  billingZip: string;
  cardholderName?: string;
  amountCents?: number;
  orderItem?: string;
}

export interface PhoneBenchmarkPaymentResult {
  status: string;
  paymentIntentId: string;
  amountCents: number;
  total: string;
  orderItem: string;
  confirmationCode: string;
  cardLastFour: string;
}

export interface PhoneBenchmarkPaymentAuditEntry {
  createdAt: string;
  toolCallId: string;
  status: string;
  paymentIntentId?: string;
  amountCents?: number;
  confirmationCode?: string;
  error?: string;
}
