import { type CardProvider } from '../../providers/card-provider';
import {
  createApprovedPurchaseSelector,
  findApprovedPurchaseRetry,
  type ApprovedPurchaseSelector,
} from './approvalReuse';
import { createStreamingCompletion } from '../../providers/rose/client';
import { ROSE_AGENT_CARD_ID } from '../../providers/card-provider/static-card';
import { tryGetLiveCardDetails } from './cardLiveness';
import { PURCHASE_APPROVAL_CACHE_HOURS } from './config';
import { PurchaseError } from './errors';
import { canonicalStoredPurchaseFingerprint } from './fingerprint';
import * as repo from './repo';
import { ensureRecentLegacyFingerprintsIndexed } from './fingerprintBackfill';
import { PurchaseSpendStatus, type MintPurchaseInput, type PurchaseLookupResult } from './types';

export async function lookupPurchase(
  userId: string,
  fingerprint: string,
  cardProvider?: CardProvider,
  now = new Date(),
  requested?: MintPurchaseInput,
  selectApprovedPurchase?: ApprovedPurchaseSelector,
  complete = createStreamingCompletion
): Promise<PurchaseLookupResult> {
  if (fingerprint.trim() === '') {
    throw new PurchaseError('fingerprint is required');
  }
  if (requested !== undefined) {
    await repo.assertPurchaseAgentAdmitted({ ...requested, userId });
    const canonical = canonicalStoredPurchaseFingerprint({
      userId,
      merchant: requested.merchant,
      lineItemsJson: requested,
      totalCents: requested.totalCents,
    });
    if (canonical === null) throw new PurchaseError('Invalid purchase receipt');
    fingerprint = canonical;
  }

  const since = new Date(now.getTime() - PURCHASE_APPROVAL_CACHE_HOURS * 60 * 60 * 1000);
  const usageItems: Array<Record<string, unknown>> = [];
  const select =
    selectApprovedPurchase ??
    createApprovedPurchaseSelector(complete, (chunk) => {
      const usage = chunk.usage;
      if (usage === undefined) return;
      usageItems.push({
        type: 'llm',
        model: chunk.actual_model,
        provider: chunk.actual_model,
        input_tokens: usage.prompt_tokens,
        output_tokens: usage.completion_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
      });
    });
  try {
    const result = await lookupAvailablePurchase(
      userId,
      fingerprint,
      cardProvider,
      since,
      requested,
      select
    );
    return { ...result, ...(usageItems.length > 0 ? { usageItems } : {}) };
  } catch (cause) {
    const error =
      cause instanceof PurchaseError
        ? cause
        : new PurchaseError(
            cause instanceof Error ? cause.message : String(cause),
            502,
            'purchase_approval_lookup_failed'
          );
    throw new PurchaseError(error.message, error.statusCode, error.code, {
      ...error.details,
      ...(usageItems.length > 0 ? { usageItems } : {}),
    });
  }
}

async function lookupAvailablePurchase(
  userId: string,
  fingerprint: string,
  cardProvider: CardProvider | undefined,
  since: Date,
  requested: MintPurchaseInput | undefined,
  select: ApprovedPurchaseSelector
): Promise<PurchaseLookupResult> {
  let purchase = await repo.findRecentPurchaseByUserAndFingerprint(userId, fingerprint, since);
  if (!purchase) {
    await ensureRecentLegacyFingerprintsIndexed(userId, since);
    purchase = await repo.findRecentPurchaseByUserAndFingerprint(userId, fingerprint, since);
  }
  if (!purchase) {
    if (requested !== undefined) {
      purchase = await findApprovedPurchaseRetry(
        { ...requested, userId, fingerprint },
        since,
        select
      );
    }
  }
  if (!purchase) {
    return {
      found: false,
      reusable: false,
      purchase: null,
    };
  }

  let reusable = purchase.status === PurchaseSpendStatus.HELD && purchase.cardId !== null;
  if (requested !== undefined && purchase.agentId !== requested.agentId) reusable = false;
  let status = purchase.status;

  // Verify supported provider availability alongside the durable HELD state.
  // A shared static card does not expose per-purchase bank spending. Reuse-only
  // mint prevents this authorization from admitting fresh purchase funding.
  if (reusable && purchase.cardId !== null) {
    const liveDetails = await tryGetLiveCardDetails(
      userId,
      purchase.agentId,
      purchase.cardId,
      cardProvider
    );
    if (!liveDetails) {
      reusable = false;
      const cleared = await repo.markHeldPurchaseClearedIfNoReclaim(purchase.id);
      if (cleared.count === 1) {
        status = PurchaseSpendStatus.CLEARED;
      } else {
        status = (await repo.findPurchaseById(purchase.id))?.status ?? purchase.status;
      }
    } else if (
      requested !== undefined &&
      purchase.cardId !== ROSE_AGENT_CARD_ID &&
      liveDetails.balanceCents < purchase.totalCents
    ) {
      // A positive remainder is not proof that a single-use card is unspent.
      reusable = false;
    }
  }

  return {
    found: true,
    reusable,
    purchase: {
      id: purchase.id,
      agentId: purchase.agentId,
      fingerprint: purchase.fingerprint,
      cardId: purchase.cardId,
      merchant: purchase.merchant,
      totalCents: purchase.totalCents,
      status,
      createdAt: purchase.createdAt,
      updatedAt: purchase.updatedAt,
    },
  };
}
