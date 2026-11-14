import crypto from 'node:crypto';
import { createCardProviderForAgent, type CardProvider } from '../../providers/card-provider';
import { createLogger } from '../../providers/logger';
import { refundCapturedPurchase } from '../../providers/stripe';
import {
  isWalletFundingConsumedDuringReclaimError,
  isWalletFundingReleasePendingError,
  type WalletFundingProvider,
} from '../../providers/wallet-funding';
import { AGENTCARD_WEBHOOK_SECRET } from './config';
import { PurchaseError } from './errors';
import * as repo from './repo';
import { PurchaseSpendStatus, type AgentCardWebhookEvent } from './types';
import { beginPurchaseWalletReclaim, reclaimPurchaseWalletFunding } from './walletFunding';

const log = createLogger('Purchases');

function extractWebhookCardId(event: AgentCardWebhookEvent): string | undefined {
  return (
    event.cardId ??
    event.card_id ??
    event.data?.cardId ??
    event.data?.card_id ??
    event.data?.card?.id
  );
}

function hasValue(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value !== '';
}

async function refundPurchaseOrRecordFailure(purchase: {
  id: string;
  stripePaymentIntentId: string | null;
  stripeLivemode: boolean;
}): Promise<void> {
  if (!hasValue(purchase.stripePaymentIntentId)) return;
  try {
    await refundCapturedPurchase(
      purchase.stripePaymentIntentId,
      purchase.id,
      purchase.stripeLivemode
    );
  } catch (error) {
    await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.REFUND_FAILED);
    throw error;
  }
}

/**
 * Close a minted card and reconcile the ledger. `HELD` means the AgentCard transfer completed and
 * the matching Stripe charge was captured, but the merchant has not settled. Abandonment therefore
 * reclaims the transfer and refunds Stripe. A settled purchase keeps its captured charge.
 * HTTP callers must supply userId; omitting it preserves the trusted internal cleanup path.
 */
export async function closePurchaseCard(
  cardId: string,
  cardProvider?: CardProvider,
  walletFundingProvider?: WalletFundingProvider,
  userId?: string
): Promise<{ ok: true; status: PurchaseSpendStatus }> {
  if (cardId.trim() === '') {
    throw new PurchaseError('cardId is required');
  }

  if (userId !== undefined && userId.trim() === '') {
    throw new PurchaseError('Authenticated user required', 401);
  }
  const purchase = await repo.findPurchaseByCardId(cardId, userId);
  if (!purchase) {
    throw new PurchaseError('Purchase card not found', 404);
  }

  if (
    purchase.status === PurchaseSpendStatus.REFUNDED ||
    purchase.status === PurchaseSpendStatus.VOIDED
  ) {
    return { ok: true, status: purchase.status };
  }

  const activeCardProvider =
    cardProvider ?? (await createCardProviderForAgent(purchase.userId, purchase.agentId));

  // Settled: the card was used and the funding charge captured; close the card but keep the charge.
  if (purchase.status === PurchaseSpendStatus.CLEARED) {
    await activeCardProvider.closeCard(cardId);
    return { ok: true, status: PurchaseSpendStatus.CLEARED };
  }

  // Funded but unspent card: reclaim AgentCard funds before refunding the user's captured charge.
  // Claim the reclaim before closing so a concurrent cleanup pass can't read the now not-live card
  // as merchant-spent while the funding is still FUNDED.
  const reclaimClaim = await beginPurchaseWalletReclaim(purchase.id);
  if (reclaimClaim.status === 'already_owned') {
    return { ok: true, status: purchase.status };
  }
  await activeCardProvider.closeCard(cardId);
  try {
    await reclaimPurchaseWalletFunding(purchase, 'purchase_card_closed', walletFundingProvider, {
      ...(reclaimClaim.status === 'owned'
        ? { reclaimLeaseToken: reclaimClaim.reclaimLeaseToken }
        : {}),
    });
  } catch (error) {
    if (isWalletFundingConsumedDuringReclaimError(error)) {
      await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CLEARED);
      return { ok: true, status: PurchaseSpendStatus.CLEARED };
    }
    const releasePending = isWalletFundingReleasePendingError(error);
    const context = {
      purchase_id: purchase.id,
      card_id: cardId,
      error: error instanceof Error ? error.message : String(error),
    };
    if (releasePending) {
      log.info('Wallet funding release is pending after closing purchase card', context);
    } else {
      log.error('Failed to reclaim wallet funding while closing purchase card', context);
    }
    if (!releasePending) {
      await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FUNDING_RECLAIM_FAILED);
      return { ok: true, status: PurchaseSpendStatus.FUNDING_RECLAIM_FAILED };
    }
    return { ok: true, status: purchase.status };
  }
  await refundPurchaseOrRecordFailure(purchase);
  await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.VOIDED);
  return { ok: true, status: PurchaseSpendStatus.VOIDED };
}

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function parseSignatureHeader(header: string): { timestamp: string; v1: string } | null {
  const parts = new Map<string, string>();
  for (const segment of header.split(',')) {
    const eq = segment.indexOf('=');
    if (eq > 0) parts.set(segment.slice(0, eq).trim(), segment.slice(eq + 1).trim());
  }
  const timestamp = parts.get('t');
  const v1 = parts.get('v1');
  if (!hasValue(timestamp) || !hasValue(v1)) return null;
  return { timestamp, v1 };
}

/**
 * Verify the AgentCard webhook signature (`AgentCard-Signature: t=<ts>,v1=<hmac>`,
 * HMAC-SHA256 over `"${t}.${rawBody}"`, secret used as-is, 5-minute replay tolerance). `rawBody` must
 * be the exact received bytes — a re-stringified parse will not match. Missing configuration
 * rejects delivery so an unsigned event cannot mutate the purchase ledger.
 */
export function verifyAgentCardWebhookSignature(rawBody: string, signatureHeader?: string): void {
  if (!hasValue(AGENTCARD_WEBHOOK_SECRET)) {
    throw new PurchaseError(
      'AgentCard webhook signing secret is not configured',
      503,
      'agentcard_webhook_unconfigured'
    );
  }
  if (!hasValue(signatureHeader)) {
    throw new PurchaseError('Missing AgentCard webhook signature', 400);
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    throw new PurchaseError('Malformed AgentCard webhook signature', 400);
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(parsed.timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > WEBHOOK_TOLERANCE_SECONDS) {
    throw new PurchaseError('AgentCard webhook timestamp outside tolerance', 400);
  }

  const expected = crypto
    .createHmac('sha256', AGENTCARD_WEBHOOK_SECRET)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest('hex');
  const received = Buffer.from(parsed.v1, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (received.length !== expectedBuf.length || !crypto.timingSafeEqual(received, expectedBuf)) {
    throw new PurchaseError('Invalid AgentCard webhook signature', 403);
  }
}

/**
 * Reconcile a purchase from an AgentCard transaction webhook:
 *  - `transaction.cleared` → consume the already-funded transfer (→ CLEARED).
 *  - `transaction.voided` → reclaim the transfer and refund the captured funding charge.
 * Already-terminal (VOIDED/REFUNDED) rows are never resurrected by a late/duplicate event.
 */
/**
 * Recovery events carry a recovery id and cardholder, never a card id, so they must be handled
 * BEFORE the card lookup below — otherwise they fall into the "webhook without card id" branch and
 * are silently dropped as noise.
 *
 * There is nothing to reconcile in our own tables: recoveries move value between AgentCard-side
 * balances (cardholder headroom -> company pool) and we hold no local row for them. The pool
 * balance is read live on every top-up. So this is deliberately observability only — it exists so
 * a stalled or rejected recovery is visible in logs rather than invisible, which is exactly the
 * failure mode that stranded $127.88 for ~6 days behind an alert that never fired upstream.
 */
function handleRecoveryEvent(event: AgentCardWebhookEvent): { ok: true } {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const context = {
    type: event.type,
    recovery_id: typeof data.id === 'string' ? data.id : undefined,
    cardholder_id: typeof data.cardholder_id === 'string' ? data.cardholder_id : undefined,
    amount_cents: typeof data.amount_cents === 'number' ? data.amount_cents : undefined,
    status: typeof data.status === 'string' ? data.status : undefined,
  };
  if (event.type === 'recovery.rejected') {
    log.error('AgentCard rejected a residual recovery; pool capital stays in the cardholder', {
      ...context,
      failure_reason: typeof data.failure_reason === 'string' ? data.failure_reason : undefined,
    });
  } else {
    log.info('AgentCard recovery event', context);
  }
  return { ok: true };
}

export async function handleAgentCardWebhook(event: AgentCardWebhookEvent): Promise<{ ok: true }> {
  if (typeof event.type === 'string' && event.type.startsWith('recovery.')) {
    return handleRecoveryEvent(event);
  }

  const cardId = extractWebhookCardId(event);
  if (!hasValue(cardId)) {
    log.warn('Ignoring AgentCard webhook without card id', { type: event.type });
    return { ok: true };
  }

  const purchase = await repo.findPurchaseByCardId(cardId);
  if (!purchase) {
    log.warn('Ignoring AgentCard webhook for unknown card', { card_id: cardId, type: event.type });
    return { ok: true };
  }

  if (
    purchase.status === PurchaseSpendStatus.VOIDED ||
    purchase.status === PurchaseSpendStatus.REFUNDED
  ) {
    return { ok: true };
  }

  if (event.type === 'transaction.cleared') {
    const result = await repo.settlePurchaseAfterTransactionCleared(purchase.id);
    if (result.outcome === 'ignored') {
      log.warn('Ignoring transaction.cleared for a purchase already being reclaimed', {
        purchase_id: purchase.id,
        card_id: cardId,
        funding_status: result.fundingStatus,
      });
    }
  } else if (event.type === 'transaction.voided') {
    if (purchase.status === PurchaseSpendStatus.CLEARED) {
      // The hold was already captured, then the card transaction reversed → refund the charge.
      try {
        await reclaimPurchaseWalletFunding(purchase, 'agentcard_transaction_voided', undefined, {
          allowConsumed: true,
        });
      } catch (error) {
        if (isWalletFundingConsumedDuringReclaimError(error)) {
          await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CLEARED);
          return { ok: true };
        }
        log.error('Failed to reclaim wallet funding after voided captured transaction', {
          purchase_id: purchase.id,
          card_id: cardId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!isWalletFundingReleasePendingError(error)) {
          await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FUNDING_RECLAIM_FAILED);
        }
        return { ok: true };
      }
      await refundPurchaseOrRecordFailure(purchase);
      await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.REFUNDED);
    } else {
      // HELD is already funded/captured; reclaim the unused transfer, then refund the user.
      try {
        await reclaimPurchaseWalletFunding(purchase, 'agentcard_transaction_voided');
      } catch (error) {
        if (isWalletFundingConsumedDuringReclaimError(error)) {
          await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.CLEARED);
          return { ok: true };
        }
        log.error('Failed to reclaim wallet funding after voided uncaptured transaction', {
          purchase_id: purchase.id,
          card_id: cardId,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!isWalletFundingReleasePendingError(error)) {
          await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.FUNDING_RECLAIM_FAILED);
        }
        return { ok: true };
      }
      await refundPurchaseOrRecordFailure(purchase);
      await repo.updatePurchaseStatus(purchase.id, PurchaseSpendStatus.VOIDED);
    }
  }

  return { ok: true };
}
