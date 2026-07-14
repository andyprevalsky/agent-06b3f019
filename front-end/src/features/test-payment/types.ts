export interface TestPaymentItem {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  priceCents: number;
  /** Relative product-page path, e.g. `/p/aurora-notebook`. Absolutized against window.location.origin for display. */
  productUrl: string;
  /** Human-readable rating containing a 0-5 numeric score, e.g. `4.8 stars`. */
  rating: string;
  /** Human-readable review count, e.g. `1,284 reviews`. */
  reviewCount: string;
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

export interface TestPaymentCardForm {
  name: string;
  number: string;
  expiry: string;
  cvv: string;
  postalCode: string;
}
