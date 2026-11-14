/* c8 ignore start -- Type-only declarations; no runtime code to cover. */

export interface TestPaymentItem {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  priceCents: number;
  /** Relative product-page path, e.g. `/p/aurora-notebook`. Exposed to the storefront page for receipt grounding. */
  productUrl: string;
  /** Human-readable rating containing a 0-5 numeric score, e.g. `4.8 stars`. */
  rating: string;
  /** Human-readable review count, e.g. `1,284 reviews`. */
  reviewCount: string;
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
  /**
   * Null when a company-funded ADMIN purchase settled: that flow mints the card off the AgentCard
   * org transfer and never authorizes a personal Stripe hold, so no payment intent exists.
   */
  paymentIntentId: string | null;
  purchaseId?: string;
  cardId?: string;
  receipt: {
    lineItems: TestPaymentReceiptLine[];
    totals: TestPaymentTotals;
  };
}

export interface StripeIntentCustody {
  purchaseId: string;
  userId: string;
  agentId: string;
  purchaseStatus: string;
  paymentIntentId: string;
  customerId: string;
  livemode: boolean;
  status: string;
  currency: string;
  amountCents: number;
  amountReceivedCents: number;
  amountCapturableCents: number;
  refundedCents: number;
  outcome: 'paid' | 'unspent' | 'refunded';
}
export interface TestPaymentLifecycle {
  stripeCustody?: StripeIntentCustody[];
  agentId: string;
  integrity: {
    purchaseCount: number;
    walletFundingCount: number;
    stripePaymentIntentCount: number;
    cardCount: number;
    stripeProviderPaymentIntentCount: number;
    agentCardProviderCardCount: number;
    agentCardProviderTransferCount: number;
    agentCardProviderUnlinkedTransferCount: number;
  };
  purchase: null | {
    id: string;
    status: string;
    merchant: string;
    totalCents: number;
    cardId: string | null;
    stripePaymentIntentId: string | null;
  };
  walletFunding: null | {
    status: string;
    amountCents: number;
    providerTransferId: string | null;
    reclaimProviderTransferId: string | null;
  };
  stripeHold: null | {
    id: string;
    livemode: boolean;
    status: string;
    amountCents: number;
    amountCapturableCents: number;
    amountReceivedCents: number;
  };
  stripeRefund: null | {
    id: string;
    /** Authoritative mode of the verified linked native PaymentIntent, not a Refund field. */
    paymentIntentId: string;
    paymentIntentLivemode: boolean;
    status: string;
    amountCents: number;
  };
  agentCard: null | {
    id: string;
    status: string;
    balanceCents: number;
  };
  orgTransfer: null | {
    id: string;
    status: string;
    amountCents: number;
    transferredCents: number;
    releasedCents: number;
    cardId: string | null;
    livemode: boolean;
  };
  attention: {
    openKinds: string[];
    resolvedKinds: string[];
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
