import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../database';
import { isAdminUser } from '../../utils/adminAccess';
import { AgentCardProviderError, createCardProviderForAgent } from '../card-provider';
import { createLogger } from '../logger';
import { callOrgTool } from './org-runtime';
import { agentCardV2Request, AgentCardV2Error, type AgentCardV2Request } from './api-v2';
import { getV2WalletOwnerId } from './wallet-v2';

const log = createLogger('AgentCardSandboxSettlement');

export interface AgentCardSandboxSettlementInput {
  cardNumber: string;
  amountCents: number;
  merchant: string;
}

/**
 * `stripePaymentIntentId` is null for a company-funded ADMIN purchase, which has no Stripe hold by
 * design. Callers must treat it as optional rather than assuming a capture exists.
 */
export interface AgentCardSandboxSettlementResult {
  purchaseId: string;
  cardId: string;
  stripePaymentIntentId: string | null;
}

export interface HeldPurchase {
  stripeLivemode?: boolean;
  walletFunding?: {
    providerTransferId: string | null;
    metadata: unknown;
  } | null;
  id: string;
  userId: string;
  agentId: string | null;
  cardId: string | null;
  stripePaymentIntentId: string | null;
}

interface AgentCardSandboxSettlementDependencies {
  v2Request?: AgentCardV2Request;
  getV2OwnerId?: (userId: string) => Promise<string | undefined>;
  findHeldPurchasesByTotal?: (amountCents: number) => Promise<HeldPurchase[]>;
  /** Optional override for already-CLEARED replay (unit tests / offline fixtures). */
  findClearedPurchasesByTotal?: (amountCents: number) => Promise<HeldPurchase[]>;
  getCardPan?: (userId: string, agentId: string | null, cardId: string) => Promise<string>;
  /**
   * Last4 recorded at mint time (wallet-funding metadata). Used when AgentCard refuses
   * `get_card_details` with `card_closed` so we can still prove the typed PAN belongs to THIS
   * purchase without falling through to raw-Stripe tokenization.
   */
  getPurchaseCardLast4Hint?: (purchaseId: string) => Promise<string | null>;
  claimHeldPurchaseForCharge?: (purchaseId: string) => Promise<boolean>;
  releaseHeldPurchaseClaim?: (purchaseId: string) => Promise<void>;
  testCharge?: (input: {
    cardId: string;
    amountCents: number;
    merchant: string;
  }) => Promise<{ isError?: boolean; message?: string }>;
  markPurchaseCleared?: (purchaseId: string) => Promise<void>;
}

export class AgentCardSandboxSettlementError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly chargeMayHaveSucceeded = false
  ) {
    super(message);
  }
}

export async function findHeldPurchasesByTotal(amountCents: number): Promise<HeldPurchase[]> {
  return prisma.purchaseSpend.findMany({
    where: {
      totalCents: amountCents,
      status: PurchaseSpendStatus.HELD,
      cardId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      userId: true,
      agentId: true,
      cardId: true,
      stripePaymentIntentId: true,
      stripeLivemode: true,
      walletFunding: { select: { providerTransferId: true, metadata: true } },
    },
  });
}

/**
 * Already-settled purchases at this total. Used to replay a successful sandbox confirm when the
 * shopper (or browser agent) re-submits Pay after the HELD → CLEARED transition — without this,
 * the second confirm 404s on the held-only lookup, `confirmTestPayment` falls through to raw-PAN
 * Stripe tokenization, and Stripe returns a PCI 500 while the merchant UI shows a false failure
 * (gate-subscription-card-mint-admin-bypass: confirm 200 then confirm 500 "Sending credit card
 * numbers directly to the Stripe API").
 */
export async function findClearedPurchasesByTotal(amountCents: number): Promise<HeldPurchase[]> {
  return prisma.purchaseSpend.findMany({
    where: {
      totalCents: amountCents,
      status: PurchaseSpendStatus.CLEARED,
      cardId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      userId: true,
      agentId: true,
      cardId: true,
      stripePaymentIntentId: true,
      stripeLivemode: true,
      walletFunding: { select: { providerTransferId: true, metadata: true } },
    },
  });
}

/**
 * Read the minted card's PAN through the AGENT-scoped provider factory. Production keeps
 * `AGENTCARD_MINT_ENABLED` off so real users get the static Brex card, but a benchmark agent must
 * still resolve the real AgentCard it just minted — the durable `Agent.isBenchmark` bit is the only
 * thing that can force that per-request. Using the env-only `createCardProvider` here returned the
 * static provider in prod, which rejects any card id but its own synthetic one, so this lookup threw
 * for exactly the benchmark runs that need it.
 */
export async function getCardPan(
  userId: string,
  agentId: string | null,
  cardId: string
): Promise<string> {
  const provider = await createCardProviderForAgent(userId, agentId);
  const details = await provider.getDetails(cardId);
  return details.pan;
}

/**
 * Provider outcomes that prove a candidate purchase is not the card that was just charged.
 *
 * A card the provider explicitly does not have (404 — e.g. the static provider rejecting a
 * pre-cutoff AgentCard id via `static_card_id_not_managed`) genuinely means "this stale HELD
 * purchase is somebody else's dead card, keep scanning".
 *
 * `card_closed` is handled separately: AgentCard stops returning credentials after close, so a
 * closed *stale* HELD must be skipped (see `agent-payment-idempotent-abandonment`), but a closed
 * card whose mint-time last4 matches the typed PAN IS this purchase — settlement must fail closed
 * (not 404→Stripe PCI) so the shopper can remint rather than raw-tokenizeizing the Rose PAN.
 *
 * Everything else — OAuth/setup gates, org rate limits, MCP transport errors, malformed provider
 * responses — means we simply COULD NOT READ the PAN. Treating those as "not this card" is a
 * money bug: the lookup for the ACTUAL Rose card fails, settlement reports 404,
 * `confirmTestPayment` falls through to the raw Stripe path, and the real Rose purchase is left
 * HELD with its wallet funding never consumed. Fail closed instead.
 */
function isCardNotFoundFailure(error: unknown): boolean {
  if (!(error instanceof AgentCardProviderError)) return false;
  if (error.status === 404 || error.code === 'static_card_id_not_managed') return true;
  return false;
}

function isCardClosedFailure(error: unknown): boolean {
  if (!(error instanceof AgentCardProviderError)) return false;
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
  if (code === 'card_closed') return true;
  return /\bcard_closed\b/i.test(error.message);
}

function normalizeCardLast4(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/**
 * Mint records `last4` on PurchaseWalletFunding.metadata. When AgentCard later refuses
 * get_card_details with card_closed, this is the only durable proof that the typed PAN belongs
 * to this purchase (full PAN is gone).
 */
export async function getPurchaseCardLast4Hint(purchaseId: string): Promise<string | null> {
  const funding = await prisma.purchaseWalletFunding.findUnique({
    where: { purchaseId },
    select: { metadata: true },
  });
  const metadata = funding?.metadata;
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  return normalizeCardLast4((metadata as Record<string, unknown>).last4);
}

async function testCharge(
  input: {
    cardId: string;
    amountCents: number;
    merchant: string;
  },
  purchase: HeldPurchase,
  dependencies: AgentCardSandboxSettlementDependencies
): Promise<{ isError?: boolean; message?: string }> {
  const metadata = purchase.walletFunding?.metadata;
  const record =
    typeof metadata === 'object' && metadata !== null ? (metadata as Record<string, unknown>) : {};
  if (record.apiVersion === 2 || record.api_version === 'v2') {
    const api = dependencies.v2Request ?? agentCardV2Request;
    const owner = await (dependencies.getV2OwnerId ?? getV2WalletOwnerId)(purchase.userId);
    const transferId = purchase.walletFunding?.providerTransferId;
    if (!owner || !transferId || purchase.stripeLivemode !== false) {
      throw new AgentCardSandboxSettlementError(
        'AgentCard sandbox settlement requires known ownership and test billing mode',
        409
      );
    }
    let transaction: Record<string, unknown>;
    const cardPath = `/api/v2/cards/${encodeURIComponent(input.cardId)}`;
    try {
      const [wallet, transfer, card] = await Promise.all([
        api('GET', '/api/v2/company_wallet'),
        api('GET', `/api/v2/company_wallet/transfers/${encodeURIComponent(transferId)}`),
        api('GET', cardPath),
      ]);
      if (
        wallet.livemode !== false ||
        transfer.livemode !== false ||
        transfer.id !== transferId ||
        transfer.card_id !== input.cardId ||
        transfer.user_id !== owner ||
        transfer.amount_cents !== input.amountCents ||
        card.id !== input.cardId ||
        card.user_id !== owner ||
        !['open', 'in_use'].includes(String(card.status)) ||
        typeof card.balance_cents !== 'number' ||
        !Number.isSafeInteger(card.balance_cents) ||
        card.balance_cents < input.amountCents
      ) {
        throw new AgentCardSandboxSettlementError(
          'AgentCard sandbox card, transfer, owner or credential mode does not match checkout',
          409
        );
      }
    } catch (error) {
      if (error instanceof AgentCardV2Error) {
        throw new AgentCardSandboxSettlementError(
          error.message,
          error.status === 404 ? 502 : error.status
        );
      }
      throw error;
    }
    try {
      // The test-charge endpoint has no idempotency contract. Never opt this POST into replay.
      transaction = await api('POST', `${cardPath}/test_charge`, {
        amount_cents: input.amountCents,
        merchant: input.merchant,
      });
    } catch (error) {
      if (error instanceof AgentCardV2Error && error.status >= 400 && error.status < 500) {
        throw new AgentCardSandboxSettlementError(
          error.message,
          error.status === 404 ? 502 : error.status
        );
      }
      throw new AgentCardSandboxSettlementError(
        'AgentCard sandbox charge outcome is unknown; refusing to replay it',
        502,
        true
      );
    }
    const chargedCard =
      typeof transaction.card === 'object' && transaction.card !== null
        ? (transaction.card as Record<string, unknown>)
        : {};
    if (transaction.status === 'declined' && transaction.card_id === input.cardId) {
      return {
        isError: true,
        message: 'AgentCard sandbox transaction was declined',
      };
    }
    if (
      transaction.object !== 'test_transaction' ||
      typeof transaction.id !== 'string' ||
      !transaction.id ||
      transaction.card_id !== input.cardId ||
      transaction.amount_cents !== input.amountCents ||
      transaction.simulated !== true ||
      transaction.status !== 'cleared' ||
      chargedCard.id !== input.cardId ||
      chargedCard.user_id !== owner
    ) {
      throw new AgentCardSandboxSettlementError(
        'AgentCard sandbox charge did not return a matching cleared transaction',
        502,
        true
      );
    }
    return { isError: false };
  }
  const result = (await callOrgTool('test_charge', {
    card_id: input.cardId,
    amount_cents: input.amountCents,
    merchant: input.merchant,
  })) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
  return {
    isError: result?.isError,
    message: (result.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n'),
  };
}

/**
 * Atomically reserve a HELD purchase for settlement by flipping it to CHARGING. Returns whether this
 * caller won the reservation. Two concurrent settlement requests that select the same HELD purchase
 * cannot both win — the loser gets `false` and must not issue the non-idempotent charge.
 */
export async function claimHeldPurchaseForCharge(purchaseId: string): Promise<boolean> {
  const claimed = await prisma.purchaseSpend.updateMany({
    where: { id: purchaseId, status: PurchaseSpendStatus.HELD },
    data: { status: PurchaseSpendStatus.CHARGING },
  });
  return claimed.count === 1;
}

/**
 * Compensating release for `claimHeldPurchaseForCharge`.
 *
 * The claim is a one-way latch out of HELD, so every failure between it and
 * `markPurchaseCleared` must put the purchase back or it is stranded: retries
 * select on `status: HELD`, find nothing, and 404 forever while the wallet
 * transfer stays FUNDED and the issued card balance goes unspent. Observed in
 * the agent-payment-setup-resume gate — one 500 from the charge left the
 * purchase CHARGING, then six consecutive
 * "No matching held AgentCard purchase was found" 404s.
 *
 * Scoped to CHARGING so it can never resurrect a purchase that a concurrent
 * cleared/abandoned transition has already moved on.
 */
async function releaseHeldPurchaseClaim(purchaseId: string): Promise<void> {
  await prisma.purchaseSpend.updateMany({
    where: { id: purchaseId, status: PurchaseSpendStatus.CHARGING },
    data: { status: PurchaseSpendStatus.HELD },
  });
}

/**
 * Funding states from which a settlement may legitimately mark the transfer CONSUMED. RECLAIMED is
 * intentionally excluded: a concurrent abandonment cleanup that already reclaimed the org-wallet
 * transfer must NOT be overwritten back to CONSUMED, or the reclaimed float is double-counted and
 * permanently drained.
 */
const CONSUMABLE_FUNDING_SOURCE_STATUSES = [
  PurchaseWalletFundingStatus.FUNDED,
  PurchaseWalletFundingStatus.CONSUMED,
  PurchaseWalletFundingStatus.RECLAIMING,
  PurchaseWalletFundingStatus.RECLAIM_FAILED,
];

export async function markPurchaseCleared(purchaseId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const updated = await tx.purchaseSpend.updateMany({
      where: { id: purchaseId, status: PurchaseSpendStatus.CHARGING },
      data: { status: PurchaseSpendStatus.CLEARED },
    });
    if (updated.count !== 1) {
      throw new AgentCardSandboxSettlementError(
        'AgentCard sandbox charge did not clear the purchase',
        502
      );
    }
    const consumed = await tx.purchaseWalletFunding.updateMany({
      where: {
        purchaseId,
        status: { in: CONSUMABLE_FUNDING_SOURCE_STATUSES },
      },
      data: {
        status: PurchaseWalletFundingStatus.CONSUMED,
        consumedAt: new Date(),
        errorMessage: null,
      },
    });
    if (consumed.count !== 1) {
      throw new AgentCardSandboxSettlementError(
        'AgentCard sandbox funding was already reclaimed or is missing',
        409
      );
    }
  });
}

async function readMatchingPurchasePan(
  purchase: HeldPurchase,
  inputCardNumber: string,
  readPan: (userId: string, agentId: string | null, cardId: string) => Promise<string>
): Promise<'match' | 'mismatch' | 'skip_not_found' | 'skip_closed'> {
  if (purchase.cardId === null) return 'mismatch';
  // A candidate whose card the provider explicitly does not have is simply NOT this card — skip
  // it. Settlement is attempted for every PAN (routing is by ownership, not BIN), so an unrelated
  // shopper card can legitimately scan past stale HELD/CLEARED purchases whose provider card no
  // longer exists; throwing there would fail an ordinary Stripe checkout because of someone else's
  // abandoned purchase. `card_closed` is a separate skip: credentials are gone, but mint-time
  // last4 may still prove ownership (handled by the caller). Any OTHER failure means the PAN
  // could not be READ — swallowing it silently mislabels the real Rose card as an ordinary card
  // and leaves its purchase HELD while Stripe charges it raw. Fail closed on those.
  let pan: string;
  try {
    pan = await readPan(purchase.userId, purchase.agentId, purchase.cardId);
  } catch (error) {
    if (isCardClosedFailure(error)) return 'skip_closed';
    if (isCardNotFoundFailure(error)) return 'skip_not_found';
    log.error('AgentCard PAN lookup failed during settlement', {
      purchaseId: purchase.id,
      cardId: purchase.cardId,
      userId: purchase.userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new AgentCardSandboxSettlementError(
      'Could not read the Rose card for a candidate purchase; refusing to treat it as a non-Rose card',
      502
    );
  }
  return pan.replace(/\s+/g, '') === inputCardNumber ? 'match' : 'mismatch';
}

/**
 * When get_card_details returns card_closed, prove ownership via mint-time last4.
 *
 * - Matching last4 on a still-HELD purchase → 409 (card closed; caller must remint — must NOT
 *   404 into confirmTestPayment's raw-Stripe fallthrough; seen 2026-09-29 setup-resume).
 * - Matching last4 on an already-CLEARED purchase → idempotent replay success (Pay re-submit).
 * - No last4 / non-matching → treat as "not this card" and keep scanning.
 */
async function resolveClosedCardCandidate(
  purchase: HeldPurchase,
  inputCardNumber: string,
  readLast4Hint: (purchaseId: string) => Promise<string | null>,
  mode: 'held' | 'cleared'
): Promise<'not_this_card' | 'closed_held_match' | 'cleared_replay'> {
  const hint = normalizeCardLast4(await readLast4Hint(purchase.id));
  const inputLast4 = normalizeCardLast4(inputCardNumber);
  if (hint === null || inputLast4 === null || hint !== inputLast4) {
    return 'not_this_card';
  }
  if (mode === 'cleared') return 'cleared_replay';
  return 'closed_held_match';
}

export async function settleAgentCardSandboxPayment(
  input: AgentCardSandboxSettlementInput,
  dependencies: AgentCardSandboxSettlementDependencies = {}
): Promise<AgentCardSandboxSettlementResult> {
  const findPurchases = dependencies.findHeldPurchasesByTotal ?? findHeldPurchasesByTotal;
  const findClearedPurchases =
    dependencies.findClearedPurchasesByTotal ?? findClearedPurchasesByTotal;
  const readPan = dependencies.getCardPan ?? getCardPan;
  const readLast4Hint = dependencies.getPurchaseCardLast4Hint ?? getPurchaseCardLast4Hint;
  const claimForCharge = dependencies.claimHeldPurchaseForCharge ?? claimHeldPurchaseForCharge;
  const releaseClaim = dependencies.releaseHeldPurchaseClaim ?? releaseHeldPurchaseClaim;
  const markCleared = dependencies.markPurchaseCleared ?? markPurchaseCleared;
  const candidates = await findPurchases(input.amountCents);

  for (const purchase of candidates) {
    if (purchase.cardId === null) continue;
    const panMatch = await readMatchingPurchasePan(purchase, input.cardNumber, readPan);
    if (panMatch === 'skip_not_found' || panMatch === 'mismatch') continue;
    if (panMatch === 'skip_closed') {
      const closed = await resolveClosedCardCandidate(
        purchase,
        input.cardNumber,
        readLast4Hint,
        'held'
      );
      if (closed === 'not_this_card') continue;
      throw new AgentCardSandboxSettlementError(
        'Rose card for this purchase is closed; credentials are unavailable. Issue a new card.',
        409
      );
    }

    // Validate the actual Stripe hold BEFORE charging so we never move funds against a purchase we
    // cannot later capture. ADMIN purchases are the one legitimate exception: `issueAdminCompanyCard`
    // funds the card entirely from the AgentCard org transfer and deliberately never authorizes a
    // Stripe hold, so `stripePaymentIntentId` is null BY DESIGN and there is nothing to capture.
    // For every other user the hold is authorized BEFORE the mint, so a HELD purchase carrying a card
    // but no payment intent is genuinely corrupt and must not be charged.
    if (purchase.stripePaymentIntentId === null && !isAdminUser(purchase.userId)) {
      throw new AgentCardSandboxSettlementError('Cleared purchase is missing its Stripe hold', 502);
    }

    // Atomically reserve the purchase before the non-idempotent charge. If another concurrent
    // settlement already claimed it, skip to the next candidate rather than double-charge.
    const claimed = await claimForCharge(purchase.id);
    if (!claimed) continue;

    // Everything from here to markCleared runs while the purchase is latched out
    // of HELD. Release the claim on every failure path — a declined charge and a
    // thrown charge/markCleared are both retryable, and leaving the row CHARGING
    // makes the retry unable to find it at all.
    let chargeConfirmed = false;
    try {
      const charge =
        dependencies.testCharge ??
        ((chargeInput: { cardId: string; amountCents: number; merchant: string }) =>
          testCharge(chargeInput, purchase, dependencies));
      const result = await charge({
        cardId: purchase.cardId,
        amountCents: input.amountCents,
        merchant: input.merchant,
      });
      if (result.isError === true) {
        throw new AgentCardSandboxSettlementError(
          `AgentCard sandbox charge failed: ${result.message ?? ''}`,
          402
        );
      }
      chargeConfirmed = true;
      await markCleared(purchase.id);
    } catch (error) {
      const fundingMetadata = purchase.walletFunding?.metadata;
      const metadata =
        typeof fundingMetadata === 'object' && fundingMetadata !== null
          ? (fundingMetadata as Record<string, unknown>)
          : {};
      const v2Charged =
        chargeConfirmed && (metadata.apiVersion === 2 || metadata.api_version === 'v2');
      if (
        !v2Charged &&
        !(error instanceof AgentCardSandboxSettlementError && error.chargeMayHaveSucceeded)
      ) {
        await releaseClaim(purchase.id);
      }
      throw error;
    }
    return {
      purchaseId: purchase.id,
      cardId: purchase.cardId,
      stripePaymentIntentId: purchase.stripePaymentIntentId,
    };
  }

  // Idempotent replay: a prior confirm already CLEARED this Rose card at this total. Re-submitting
  // Pay must return the settled result — never fall through to raw-PAN Stripe.
  const clearedCandidates = await findClearedPurchases(input.amountCents);
  for (const purchase of clearedCandidates) {
    if (purchase.cardId === null) continue;
    const panMatch = await readMatchingPurchasePan(purchase, input.cardNumber, readPan);
    if (panMatch === 'skip_closed') {
      const closed = await resolveClosedCardCandidate(
        purchase,
        input.cardNumber,
        readLast4Hint,
        'cleared'
      );
      if (closed !== 'cleared_replay') continue;
      return {
        purchaseId: purchase.id,
        cardId: purchase.cardId,
        stripePaymentIntentId: purchase.stripePaymentIntentId,
      };
    }
    if (panMatch !== 'match') continue;
    return {
      purchaseId: purchase.id,
      cardId: purchase.cardId,
      stripePaymentIntentId: purchase.stripePaymentIntentId,
    };
  }

  throw new AgentCardSandboxSettlementError('No matching held AgentCard purchase was found', 404);
}
