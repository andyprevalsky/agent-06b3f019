import { PurchaseSpendStatus, PurchaseWalletFundingStatus } from '@prisma/client';
import { prisma } from '../database';
import { createCardProvider } from '../card-provider';
import { callOrgTool } from './org-runtime';

export interface AgentCardSandboxSettlementInput {
  cardNumber: string;
  amountCents: number;
  merchant: string;
}

export interface AgentCardSandboxSettlementResult {
  purchaseId: string;
  cardId: string;
  stripePaymentIntentId: string;
}

interface HeldPurchase {
  id: string;
  userId: string;
  cardId: string | null;
  stripePaymentIntentId: string | null;
}

interface AgentCardSandboxSettlementDependencies {
  findHeldPurchasesByTotal?: (amountCents: number) => Promise<HeldPurchase[]>;
  getCardPan?: (userId: string, cardId: string) => Promise<string>;
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

async function findHeldPurchasesByTotal(amountCents: number): Promise<HeldPurchase[]> {
  return prisma.purchaseSpend.findMany({
    where: { totalCents: amountCents, status: PurchaseSpendStatus.HELD, cardId: { not: null } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      userId: true,
      cardId: true,
      stripePaymentIntentId: true,
    },
  });
}

async function getCardPan(userId: string, cardId: string): Promise<string> {
  const details = await createCardProvider(userId).getDetails(cardId);
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
async function claimHeldPurchaseForCharge(purchaseId: string): Promise<boolean> {
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

async function markPurchaseCleared(purchaseId: string): Promise<void> {
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
    const pan = await readPan(purchase.userId, purchase.cardId);
    if (pan.replace(/\s+/g, '') !== input.cardNumber) continue;

    // Validate the actual Stripe hold BEFORE charging so we never move funds against a purchase we
    // cannot later capture.
    if (purchase.stripePaymentIntentId === null) {
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
