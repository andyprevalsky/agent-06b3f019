import {
  isCardLive,
  type CardProvider,
  type CardProviderDetailsResult,
  type CardProviderMintResult,
} from '../../providers/card-provider';
import { PurchaseError } from './errors';

export function sanitizeDescriptorSuffix(merchant: string): string {
  const cleaned = merchant
    .replace(/[^a-zA-Z0-9 ._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || 'Purchase').slice(0, 22);
}

export function assertIssuedCardIsSpendable(
  details: CardProviderDetailsResult,
  requiredBalanceCents: number
): void {
  if (!isCardLive(details) || details.balanceCents < requiredBalanceCents) {
    throw new PurchaseError(
      'AgentCard returned a card that is not live and fully funded',
      502,
      'agentcard_company_card_unusable',
      {
        cardStatus: details.status,
        balanceCents: details.balanceCents,
        requiredBalanceCents,
      }
    );
  }
}

/** Prefer secrets already fetched during mint; only call getDetails when mint omitted them. */
export async function resolveIssuedCardDetails(
  minted: CardProviderMintResult,
  cardProvider: CardProvider
): Promise<CardProviderDetailsResult> {
  if (
    typeof minted.pan === 'string' &&
    minted.pan.trim() !== '' &&
    typeof minted.cvv === 'string' &&
    minted.cvv.trim() !== '' &&
    typeof minted.balanceCents === 'number' &&
    Number.isFinite(minted.balanceCents)
  ) {
    return {
      pan: minted.pan,
      cvv: minted.cvv,
      expiry: minted.expiry,
      balanceCents: minted.balanceCents,
      status: minted.status,
    };
  }
  return cardProvider.getDetails(minted.cardId);
}
