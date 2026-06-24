export interface TestPaymentItem {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  priceCents: number;
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
