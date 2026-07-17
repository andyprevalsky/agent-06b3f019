import { AgentCardRoutingProvider } from './agentcard-routing';
import type { CardProvider, CardProviderDetailsResult } from './types';

export type {
  CardProvider,
  CardProviderDetailsResult,
  CardProviderMintRequest,
  CardProviderMintResult,
} from './types';
export { AgentCardProviderError } from './errors';
export { AgentCardOrgMcpProvider } from './agentcard-org-mcp';
export { AgentCardRoutingProvider } from './agentcard-routing';
export { AgentCardUserMcpProvider } from './agentcard-user-mcp';

export function createCardProvider(userId: string): CardProvider {
  return new AgentCardRoutingProvider(userId);
}

/** Card statuses (from the provider) where the card is still live and can be reused. */
const LIVE_CARD_STATUSES = new Set(['OPEN', 'ACTIVE']);

/**
 * Whether a minted card is still live and unspent — the source of truth for whether a single-use
 * AgentCard card has actually been consumed. It flips to `CLOSED` / `balanceCents 0` the moment a
 * merchant settles a charge (verified against `sk_test_`). Callers ask the card itself rather than
 * trusting that a `transaction.cleared` webhook was delivered.
 */
export function isCardLive(details: CardProviderDetailsResult): boolean {
  return details.balanceCents > 0 && LIVE_CARD_STATUSES.has(details.status.trim().toUpperCase());
}
