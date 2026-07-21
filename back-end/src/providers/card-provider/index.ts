import { AgentCardRoutingProvider } from './agentcard-routing';
import { agentCardMintEnabled, StaticRoseAgentCardProvider } from './static-card';
import type { CardProvider, CardProviderDetailsResult } from './types';
import { isBenchmarkAgent } from '../benchmarkAgent';

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
// Export ONLY the gate and the provider — never the credential accessors
// (`roseAgentCard`/PAN/CVV). Those stay internal to `static-card.ts`; anything
// that needs raw card values imports them from there directly (e.g. tests).
export { agentCardMintEnabled, StaticRoseAgentCardProvider } from './static-card';

/**
 * Resolve the card provider for a user. HARD CUTOFF: until AgentCard minting is enabled
 * (`AGENTCARD_MINT_ENABLED` truthy), every mint returns the static Rose Agent Card (a real
 * company-funded Brex card) instead of calling the not-yet-usable AgentCard MCP.
 */
export function createCardProvider(userId: string): CardProvider {
  if (!agentCardMintEnabled()) {
    return new StaticRoseAgentCardProvider();
  }
  return new AgentCardRoutingProvider(userId);
}

interface BenchmarkAgentResolver {
  isBenchmarkAgent: (agentId: string | null | undefined) => Promise<boolean>;
}

/**
 * Resolve a provider for one agent request. Production shares one backend process between normal
 * users and the benchmark harness, so process-level BENCHMARK_MODE cannot identify a production
 * benchmark. The durable Agent.isBenchmark bit keeps the override request-scoped: evals exercise
 * real AgentCard lifecycle behavior while ordinary users remain behind the static-card cutoff.
 */
export async function createCardProviderForAgent(
  userId: string,
  agentId: string | null | undefined,
  resolver: BenchmarkAgentResolver = { isBenchmarkAgent }
): Promise<CardProvider> {
  if (agentCardMintEnabled() || (await resolver.isBenchmarkAgent(agentId))) {
    return new AgentCardRoutingProvider(userId);
  }
  return new StaticRoseAgentCardProvider();
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
