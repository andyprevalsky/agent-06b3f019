/**
 * Platform GMV from completed agent structured outputs.
 *
 * SYSTEM CONTEXT:
 * Agent / browser completion with structured_response
 *   -> extractStructuredGmv (USD amount + confirmation/order id)
 *   -> recordStructuredGmv
 *      -> skip when fingerprint (userId+confirmationId) already exists
 *      -> skip when AgentCard PurchaseSpend already covers this agent+amount
 *      -> else PurchaseSpend { provider: order_confirmation, status: CLEARED }
 *   -> admin-health sums CLEARED PurchaseSpend as platform GMV
 *
 * AgentCard mint clearances remain a separate GMV source on the same ledger.
 * Write-lock approval alone is NOT recorded — it is not proof of payment.
 */

import { createHash } from 'node:crypto';

import { createLogger } from '../../providers/logger';
import * as repo from './repo';
import { extractStructuredGmv, type StructuredGmvCapture } from './structuredGmvExtract';
import { PurchaseSpendStatus } from './types';

const log = createLogger('StructuredGmv');

export const ORDER_CONFIRMATION_PROVIDER = 'order_confirmation';
export const MERCHANT_SAVED_PROVIDER = 'merchant_saved';

const AGENTCARD_COVERED_STATUSES: PurchaseSpendStatus[] = [
  PurchaseSpendStatus.PENDING_APPROVAL,
  PurchaseSpendStatus.CHARGING,
  PurchaseSpendStatus.FUNDING_PENDING,
  PurchaseSpendStatus.HELD,
  PurchaseSpendStatus.CLEARED,
  PurchaseSpendStatus.CAPTURE_FAILED,
  PurchaseSpendStatus.FUNDING_RECLAIM_FAILED,
  PurchaseSpendStatus.REFUND_FAILED,
];

const AGENTCARD_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export type RecordStructuredGmvResult =
  | { status: 'recorded'; purchaseId: string; created: boolean; confirmationId: string }
  | { status: 'skipped'; reason: string };

function buildConfirmationFingerprint(userId: string, confirmationId: string): string {
  const identity = {
    kind: 'order_confirmation_gmv',
    userId,
    confirmationId: confirmationId.trim().toLowerCase(),
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

async function agentcardCoversPurchase(
  agentId: string | undefined,
  totalCents: number
): Promise<string | null> {
  if (agentId === undefined) return null;
  const covered = await repo.findAgentcardCoveringPurchase({
    agentId,
    totalCents,
    statuses: AGENTCARD_COVERED_STATUSES,
    since: new Date(Date.now() - AGENTCARD_LOOKBACK_MS),
  });
  return covered?.id ?? null;
}

function buildLineItemsJson(
  capture: StructuredGmvCapture,
  source: string | undefined
): Record<string, unknown> {
  return {
    currency: 'USD',
    lineItems: [],
    fees: [],
    subtotalCents: capture.totalCents,
    totalCents: capture.totalCents,
    confirmationId: capture.confirmationId,
    amountKey: capture.amountKey,
    confirmationKey: capture.confirmationKey,
    source: source ?? 'structured_response',
    sourceFields: capture.sourceFields,
  };
}

function isAgentForeignKeyError(error: unknown, agentId: string | undefined): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2003' &&
    agentId !== undefined
  );
}

async function createClearedConfirmationPurchase(input: {
  userId: string;
  agentId: string | undefined;
  fingerprint: string;
  capture: StructuredGmvCapture;
  source: string | undefined;
  occurredAt: Date | undefined;
}): Promise<{ id: string }> {
  const lineItemsJson = buildLineItemsJson(input.capture, input.source);
  const payload = {
    userId: input.userId,
    fingerprint: input.fingerprint,
    merchant: input.capture.merchant.slice(0, 200),
    lineItemsJson,
    totalCents: input.capture.totalCents,
    ...(input.occurredAt !== undefined ? { createdAt: input.occurredAt } : {}),
  };

  try {
    return await repo.createClearedOrderConfirmation({
      ...payload,
      agentId: input.agentId,
    });
  } catch (error) {
    // Historical R2 backfill: agent rows are often deleted while fixtures remain.
    if (!isAgentForeignKeyError(error, input.agentId)) throw error;
    log.info('Structured GMV agent missing; recording without agentId', {
      agentId: input.agentId,
      confirmationId: input.capture.confirmationId,
    });
    return repo.createClearedOrderConfirmation({
      ...payload,
      agentId: undefined,
    });
  }
}

export async function recordStructuredGmv(input: {
  userId: string;
  agentId?: string;
  structured: unknown;
  source?: string;
  /** Optional historical attribution time (backfill). Defaults to now. */
  occurredAt?: Date;
}): Promise<RecordStructuredGmvResult> {
  const capture = extractStructuredGmv(input.structured);
  if (capture === null) {
    return { status: 'skipped', reason: 'missing_amount_or_confirmation' };
  }

  const trimmedAgentId = input.agentId?.trim();
  const agentId =
    trimmedAgentId !== undefined && trimmedAgentId !== '' ? trimmedAgentId : undefined;

  const agentcardId = await agentcardCoversPurchase(agentId, capture.totalCents);
  if (agentcardId !== null) {
    log.info('Skipping structured GMV; AgentCard purchase already covers agent+amount', {
      agentId,
      purchaseId: agentcardId,
      totalCents: capture.totalCents,
      confirmationId: capture.confirmationId,
    });
    return { status: 'skipped', reason: 'agentcard_purchase_exists' };
  }

  const fingerprint = buildConfirmationFingerprint(input.userId, capture.confirmationId);
  const existing = await repo.findOrderConfirmationByFingerprint({
    userId: input.userId,
    fingerprint,
    confirmationId: capture.confirmationId,
  });
  if (existing !== null) {
    return {
      status: 'recorded',
      purchaseId: existing.id,
      created: false,
      confirmationId: capture.confirmationId,
    };
  }

  const purchase = await createClearedConfirmationPurchase({
    userId: input.userId,
    agentId,
    fingerprint,
    capture,
    source: input.source,
    occurredAt: input.occurredAt,
  });

  log.info('Recorded structured-output GMV', {
    purchaseId: purchase.id,
    userId: input.userId,
    agentId,
    merchant: capture.merchant,
    totalCents: capture.totalCents,
    confirmationId: capture.confirmationId,
    source: input.source ?? 'structured_response',
  });

  return {
    status: 'recorded',
    purchaseId: purchase.id,
    created: true,
    confirmationId: capture.confirmationId,
  };
}

/** Best-effort wrapper for hot paths — never throws into message/status writers. */
export async function maybeRecordStructuredGmv(input: {
  userId: string;
  agentId?: string;
  structured: unknown;
  source?: string;
}): Promise<void> {
  try {
    await recordStructuredGmv(input);
  } catch (error) {
    log.warn('Structured GMV record failed', {
      agentId: input.agentId,
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
