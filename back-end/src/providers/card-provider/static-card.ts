/**
 * Hard cutoff for AgentCard minting.
 *
 * AgentCard card issuance is not yet usable end-to-end (cardholder KYC / org
 * onboarding is still being staged). Until it is, every mint hands back one
 * real, company-funded Brex card — the "Rose Agent Card" — instead of calling the
 * (currently unusable) AgentCard MCP. The card carries its OWN $50/week spend
 * limit at Brex, so it is safe to reuse across purchases and enforces the cap
 * without any of our single-use funding machinery.
 *
 * Flip `AGENTCARD_MINT_ENABLED` truthy to route real mints through
 * `AgentCardRoutingProvider` again (see `createCardProvider`). The cutoff is the
 * DEFAULT: with the flag unset/falsy, minting NEVER touches AgentCard.
 *
 * SECURITY: the physical card's PAN/CVV/PIN are NEVER hardcoded here. They are
 * injected at runtime from the secret store (env: `ROSE_AGENT_CARD_PAN` / `_CVV`
 * / `_EXPIRY` / `_PIN`), and `roseAgentCard()` throws if any is missing rather
 * than falling back to a real card baked into source. Only non-sensitive metadata
 * (a synthetic card id, the cardholder label, and the weekly cap) lives in code.
 */

import { AgentCardProviderError } from './errors';
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

/**
 * Synthetic id for the single static Rose Agent Card. It is NOT a provider card id — the static
 * card is never minted or closed at any provider — but it flows through the purchase records so
 * reuse/liveness logic has a stable handle, and the provider rejects any other id (see
 * `assertStaticCardId`).
 */
export const ROSE_AGENT_CARD_ID = 'rose-agent-card-static';

/** Non-sensitive Rose Agent Card metadata (safe to keep in source; no card credentials here). */
export const ROSE_AGENT_CARD_META = {
  cardId: ROSE_AGENT_CARD_ID,
  cardholder: 'Rose Labs',
  /** The physical Brex card's fixed weekly cap; the merchant/Brex enforces it, we only report it. */
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

function requiredCardEnv(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    throw new AgentCardProviderError(
      `AgentCard mint cutoff is active but ${name} is not configured; set the Rose Agent Card ` +
        `credentials in the secret store (ROSE_AGENT_CARD_PAN/_CVV/_EXPIRY/_PIN)`,
      500,
      undefined,
      'rose_agent_card_not_configured'
    );
  }
  return raw.trim();
}

/**
 * The static Rose Agent Card — a real Brex company card handed out while the cutoff is active.
 * Credentials are read from the secret store on every call (so rotation needs no code change) and
 * are REQUIRED: a missing value throws rather than silently minting a stale/bogus card.
 */
export function roseAgentCard(): RoseAgentCard {
  return {
    cardId: ROSE_AGENT_CARD_META.cardId,
    pan: requiredCardEnv('ROSE_AGENT_CARD_PAN'),
    cvv: requiredCardEnv('ROSE_AGENT_CARD_CVV'),
    expiry: requiredCardEnv('ROSE_AGENT_CARD_EXPIRY'),
    pin: requiredCardEnv('ROSE_AGENT_CARD_PIN'),
    cardholder: process.env.ROSE_AGENT_CARD_CARDHOLDER?.trim() || ROSE_AGENT_CARD_META.cardholder,
    spendLimitCents: ROSE_AGENT_CARD_META.spendLimitCents,
  };
}

/**
 * CardProvider that ignores AgentCard entirely and always returns the static Rose Agent Card.
 * `mintCard`/`getDetails` are idempotent and side-effect-free; `closeCard` is a deliberate no-op —
 * the shared company card must never be closed by the single-use card lifecycle. Every method
 * operates ONLY on the static card id and rejects any other id so this provider can never
 * masquerade as the manager of a real AgentCard card.
 */
export class StaticRoseAgentCardProvider implements CardProvider {
  async mintCard(_request: CardProviderMintRequest): Promise<CardProviderMintResult> {
    const card = roseAgentCard();
    return {
      cardId: card.cardId,
      last4: card.pan.slice(-4),
      expiry: card.expiry,
      // The card's own fixed weekly cap — NOT the requested amount. Brex enforces the real limit;
      // echoing arbitrary caller input here would misreport the card's capability.
      spendLimitCents: card.spendLimitCents,
      status: 'OPEN',
      // No providerTransferId: the static Brex card is company-funded out-of-band, so there is no
      // AgentCard company transfer to reconcile. The charge flow recognizes static-card funding via
      // `metadata.staticCard` and skips the transfer/wallet-funding accounting (Stripe is still
      // captured). Fabricating a transfer id would make downstream reclaim act on a nonexistent
      // object.
      metadata: { staticCard: true },
    };
  }

  async getDetails(cardId: string): Promise<CardProviderDetailsResult> {
    assertStaticCardId(cardId, 'getDetails');
    const card = roseAgentCard();
    return {
      pan: card.pan,
      cvv: card.cvv,
      expiry: card.expiry,
      // Bounded to the weekly cap (not MAX_SAFE_INTEGER). Positive + OPEN keeps `isCardLive` true so
      // the reusable company card is treated as unspent rather than re-minted every purchase.
      balanceCents: card.spendLimitCents,
      status: 'OPEN',
    };
  }

  async closeCard(cardId: string): Promise<void> {
    assertStaticCardId(cardId, 'closeCard');
    // Intentional no-op: the shared static company card must never be closed.
  }
}

/**
 * Guard: this provider manages ONLY the static card. Any other id (e.g. a real AgentCard card
 * minted before the cutoff) must be rejected so we never silently report success for — or leak the
 * static card's details in place of — a card we do not manage. Callers that reconcile historical
 * cards already treat a throw here as "not live / not ours" and fall back to a fresh purchase.
 */
function assertStaticCardId(cardId: string, op: string): void {
  if (cardId !== ROSE_AGENT_CARD_ID) {
    throw new AgentCardProviderError(
      `StaticRoseAgentCardProvider.${op} received an id it does not manage (${cardId}); the mint ` +
        `cutoff only manages the static Rose Agent Card`,
      404,
      undefined,
      'static_card_id_not_managed'
    );
  }
}
