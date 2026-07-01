export interface CardProviderMintRequest {
  amountCents: number;
  idempotencyKey?: string;
}

export interface CardProviderMintResult {
  cardId: string;
  last4: string;
  expiry: string;
  spendLimitCents: number;
  status: string;
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
