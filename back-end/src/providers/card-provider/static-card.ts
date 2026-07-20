/**
 * Hard cutoff for AgentCard minting.
 *
 * AgentCard card issuance is not yet usable end-to-end (cardholder KYC / org
 * onboarding is still being staged). Until it is, every mint must hand back one
 * real, company-funded Brex card — the "Rose Agent Card" — instead of calling the
 * (currently unusable) AgentCard MCP. The card carries its OWN $50/week spend
 * limit at Brex, so it is safe to reuse across purchases and enforces the cap
 * without any of our funding machinery.
 *
 * Flip `AGENTCARD_MINT_ENABLED` truthy to route real mints through
 * `AgentCardRoutingProvider` again (see `createCardProvider`). The cutoff is the
 * DEFAULT: with the flag unset/falsy, minting NEVER touches AgentCard.
 */

import type {
  CardProvider,
  CardProviderDetailsResult,
  CardProviderMintRequest,
  CardProviderMintResult,
} from './types';

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function envTruthy(name: string): boolean {
  return TRUTHY.has((process.env[name] ?? '').trim().toLowerCase());
}

/**
 * Whether the process is running a benchmark/eval (isolated or otherwise). Benchmarks MUST always
 * exercise the real AgentCard mint path: the lifecycle evals assert real org transfers / Stripe
 * refunds / card closure, and — critically — the static card is a REAL Brex card, so a benchmark
 * that fell through to it would attempt real charges against the shared $50/week company card. So
 * benchmark mode force-enables real minting regardless of the cutoff flag.
 */
function benchmarkModeEnabled(): boolean {
  return envTruthy('BENCHMARK_MODE') || envTruthy('BENCHMARK_ISOLATED_RUN');
}

/**
 * Whether real AgentCard minting is enabled. Off (hard cutoff active) by default for real user
 * traffic: an unset or falsy `AGENTCARD_MINT_ENABLED` returns the static Rose Agent Card. Always
 * ON under benchmark mode so evals never touch the real Brex card (see `benchmarkModeEnabled`).
 */
export function agentCardMintEnabled(): boolean {
  return envTruthy('AGENTCARD_MINT_ENABLED') || benchmarkModeEnabled();
}

function envOr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw !== undefined && raw.trim() !== '' ? raw.trim() : fallback;
}

/**
 * Default static-card values — the current physical Brex "Rose Agent Card". `pin` is recorded for
 * completeness (ATM / card-present use); online card-not-present checkouts — what the agent does —
 * authenticate with the CVV, not the PIN, so it never flows into `getDetails`.
 */
export const ROSE_AGENT_CARD_DEFAULTS = {
  cardId: 'rose-agent-card-static',
  pan: '5440150143481372',
  cvv: '086',
  expiry: '02/29',
  pin: '8318',
  cardholder: 'Andy Prevalsky',
  spendLimitCents: 5000,
} as const;

export interface RoseAgentCard {
  cardId: string;
  pan: string;
  cvv: string;
  expiry: string;
  pin: string;
  cardholder: string;
  spendLimitCents: number;
}

/**
 * The static Rose Agent Card — a real Brex company card handed out while the cutoff is active.
 * Resolved per-call so the physical card can be rotated via env without a code change
 * (`ROSE_AGENT_CARD_PAN` / `_CVV` / `_EXPIRY` / `_PIN`), falling back to the current defaults.
 */
export function roseAgentCard(): RoseAgentCard {
  return {
    cardId: ROSE_AGENT_CARD_DEFAULTS.cardId,
    pan: envOr('ROSE_AGENT_CARD_PAN', ROSE_AGENT_CARD_DEFAULTS.pan),
    cvv: envOr('ROSE_AGENT_CARD_CVV', ROSE_AGENT_CARD_DEFAULTS.cvv),
    expiry: envOr('ROSE_AGENT_CARD_EXPIRY', ROSE_AGENT_CARD_DEFAULTS.expiry),
    pin: envOr('ROSE_AGENT_CARD_PIN', ROSE_AGENT_CARD_DEFAULTS.pin),
    cardholder: ROSE_AGENT_CARD_DEFAULTS.cardholder,
    spendLimitCents: ROSE_AGENT_CARD_DEFAULTS.spendLimitCents,
  };
}

/**
 * CardProvider that ignores AgentCard entirely and always returns the static Rose Agent Card.
 * `mintCard`/`getDetails` are idempotent and side-effect-free; `closeCard` is a deliberate no-op —
 * the shared company card must never be closed by the single-use card lifecycle.
 */
export class StaticRoseAgentCardProvider implements CardProvider {
  async mintCard(request: CardProviderMintRequest): Promise<CardProviderMintResult> {
    const card = roseAgentCard();
    return {
      cardId: card.cardId,
      last4: card.pan.slice(-4),
      expiry: card.expiry,
      spendLimitCents: request.amountCents,
      status: 'OPEN',
      // Non-empty so the company-funding transfer-id guard in the charge flow passes. There is no
      // real AgentCard transfer behind the static card — the Brex card is funded out-of-band.
      providerTransferId: card.cardId,
      metadata: { staticCard: true },
    };
  }

  async getDetails(_cardId: string): Promise<CardProviderDetailsResult> {
    const card = roseAgentCard();
    return {
      pan: card.pan,
      cvv: card.cvv,
      expiry: card.expiry,
      // Always live: the real company card is reusable, so reuse/liveness checks treat it as unspent
      // rather than re-minting a fresh (nonexistent) single-use card.
      balanceCents: Number.MAX_SAFE_INTEGER,
      status: 'OPEN',
    };
  }

  async closeCard(_cardId: string): Promise<void> {
    // Intentional no-op: never close the shared static company card.
  }
}
