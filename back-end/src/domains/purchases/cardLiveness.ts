import {
  createCardProviderForAgent,
  isCardLive,
  type CardProvider,
  type CardProviderDetailsResult,
} from '../../providers/card-provider';
import { isClosedCardDetailsError } from '../../providers/card-provider/errors';
import { createLogger } from '../../providers/logger';

const log = createLogger('Purchases');

/**
 * Return details only for a reusable card. A known closed card returns null; an unknown provider
 * read failure propagates so it cannot clear a purchase or authorize another charge.
 */
export async function tryGetLiveCardDetails(
  userId: string,
  agentId: string | null,
  cardId: string,
  cardProvider?: CardProvider
): Promise<CardProviderDetailsResult | null> {
  // Provider selection may perform a database lookup. Let those errors propagate so a transient
  // benchmark-classification failure cannot be mistaken for a consumed card and trigger billing.
  const activeCardProvider = cardProvider ?? (await createCardProviderForAgent(userId, agentId));
  try {
    const details = await activeCardProvider.getDetails(cardId);
    return isCardLive(details) ? details : null;
  } catch (error) {
    if (isClosedCardDetailsError(error)) return null;
    log.warn('Reuse liveness check failed; preserving purchase state', {
      card_id: cardId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
