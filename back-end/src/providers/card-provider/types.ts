export interface CardProviderMintRequest {
  amountCents: number;
  idempotencyKey?: string;
  fundsSource?: 'onramp_flow' | 'company_flow';
  /** Immutable purchase billing mode. Required by the server-side v2 issuer. */
  expectedLivemode?: boolean;
}

export interface CardProviderMintResult {
  cardId: string;
  last4: string;
  expiry: string;
  spendLimitCents: number;
  status: string;
  providerTransferId?: string;
  metadata?: Record<string, unknown>;
  /**
   * When the provider already fetched live card secrets during mint (org MCP
   * always does; user MCP may), callers must reuse these instead of issuing a
   * second getDetails — a redundant get_card_details has hung mint for minutes
   * while the purchase stayed CHARGING and blocked fingerprint retries with 409.
   */
  pan?: string;
  cvv?: string;
  balanceCents?: number;
}

export interface CardProviderDetailsResult {
  pan: string;
  cvv: string;
  expiry: string;
  balanceCents: number;
  status: string;
}

export interface CardProvider {
  mintCard(request: CardProviderMintRequest): Promise<CardProviderMintResult>;
  getDetails(cardId: string): Promise<CardProviderDetailsResult>;
  closeCard(cardId: string): Promise<void>;
}
