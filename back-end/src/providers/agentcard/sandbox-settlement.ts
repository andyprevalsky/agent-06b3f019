import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../database';
import { isAdminUser } from '../../utils/adminAccess';
import { createCardProviderForAgent } from '../card-provider';
import { callOrgTool } from './org-runtime';

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
  id: string;
  userId: string;
  agentId: string | null;
  cardId: string | null;
  stripePaymentIntentId: string | null;
}

interface AgentCardSandboxSettlementDependencies {
  findHeldPurchasesByTotal?: (amountCents: number) => Promise<HeldPurchase[]>;
  getCardPan?: (userId: string, agentId: string | null, cardId: string) => Promise<string>;
  claimHeldPurchaseForCharge?: (purchaseId: string) => Promise<boolean>;
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
    readonly statusCode: number
  ) {
    super(message);
  }
}

export async function findHeldPurchasesByTotal(amountCents: number): Promise<HeldPurchase[]> {
  return prisma.purchaseSpend.findMany({
    where: { totalCents: amountCents, status: PurchaseSpendStatus.HELD, cardId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      userId: true,
      agentId: true,
      cardId: true,
      stripePaymentIntentId: true,
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

async function testCharge(input: {
  cardId: string;
  amountCents: number;
  merchant: string;
}): Promise<{ isError?: boolean; message?: string }> {
  const result = (await callOrgTool('test_charge', {
    card_id: input.cardId,
    amount_cents: input.amountCents,
    merchant: input.merchant,
  })) as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
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

export async function settleAgentCardSandboxPayment(
  input: AgentCardSandboxSettlementInput,
  dependencies: AgentCardSandboxSettlementDependencies = {}
): Promise<AgentCardSandboxSettlementResult> {
  const findPurchases = dependencies.findHeldPurchasesByTotal ?? findHeldPurchasesByTotal;
  const readPan = dependencies.getCardPan ?? getCardPan;
  const claimForCharge = dependencies.claimHeldPurchaseForCharge ?? claimHeldPurchaseForCharge;
  const charge = dependencies.testCharge ?? testCharge;
  const markCleared = dependencies.markPurchaseCleared ?? markPurchaseCleared;
  const candidates = await findPurchases(input.amountCents);

  for (const purchase of candidates) {
    if (purchase.cardId === null) continue;
    // A candidate we cannot resolve a PAN for is simply NOT this card — skip it. Settlement is now
    // attempted for every PAN (routing is by ownership, not BIN), so an unrelated shopper card can
    // legitimately scan past stale HELD purchases whose provider card no longer resolves. Throwing
    // here would fail an ordinary Stripe checkout because of someone else's abandoned purchase.
    let pan: string;
    try {
      pan = await readPan(purchase.userId, purchase.agentId, purchase.cardId);
    } catch {
      continue;
    }
    if (pan.replace(/\s+/g, '') !== input.cardNumber) continue;

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
    await markCleared(purchase.id);
    return {
      purchaseId: purchase.id,
      cardId: purchase.cardId,
      stripePaymentIntentId: purchase.stripePaymentIntentId,
    };
  }

  throw new AgentCardSandboxSettlementError('No matching held AgentCard purchase was found', 404);
}
