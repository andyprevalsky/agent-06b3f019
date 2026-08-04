/**
 * Facilitated GMV (merchant card-on-file) ledger writes.
 *
 * SYSTEM CONTEXT:
 * Browser agent purchase write-lock approved
 *   -> POST /api/purchases/record-facilitated-gmv
 *      -> skip when an AgentCard PurchaseSpend already covers this agent
 *      -> else idempotent PurchaseSpend { provider: merchant_saved, status: CLEARED }
 *   -> admin-health sums CLEARED PurchaseSpend.totalCents as platform GMV
 *
 * AgentCard mint path already writes PurchaseSpend; this path covers Blue Bottle /
 * DoorDash-style checkouts that charge a merchant-saved card and never mint.
 */

import { createHash } from 'node:crypto';
import { PurchaseSpendStatus, type Prisma } from '@prisma/client';

import { prisma } from '../../providers/database';
import { createLogger } from '../../providers/logger';

const log = createLogger('FacilitatedGmv');

export const MERCHANT_SAVED_PROVIDER = 'merchant_saved';

/** Statuses that mean an AgentCard purchase already accounts for this agent's spend. */
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

export interface RecordFacilitatedGmvInput {
  userId: string;
  agentId?: string;
  merchant: string;
  totalCents: number;
  currency?: string;
  paymentMethod?: string;
  domain?: string;
  approvedAt?: number;
  lineItems?: unknown[];
  totals?: Record<string, unknown>;
}

export type RecordFacilitatedGmvResult =
  | { status: 'recorded'; purchaseId: string; created: boolean }
  | { status: 'skipped'; reason: string };

function buildFacilitatedFingerprint(input: RecordFacilitatedGmvInput): string {
  const identity = {
    kind: 'facilitated_gmv',
    userId: input.userId,
    agentId: input.agentId ?? null,
    merchant: input.merchant.trim().toLowerCase(),
    totalCents: input.totalCents,
    domain: (input.domain ?? '').trim().toLowerCase(),
    approvedAt: input.approvedAt ?? null,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export async function recordFacilitatedGmv(
  input: RecordFacilitatedGmvInput
): Promise<RecordFacilitatedGmvResult> {
  const merchant = input.merchant.trim();
  if (merchant === '') {
    return { status: 'skipped', reason: 'missing_merchant' };
  }
  if (!Number.isInteger(input.totalCents) || input.totalCents <= 0) {
    return { status: 'skipped', reason: 'invalid_total_cents' };
  }

  const trimmedAgentId = input.agentId?.trim();
  const agentId =
    trimmedAgentId !== undefined && trimmedAgentId !== '' ? trimmedAgentId : undefined;
  if (agentId !== undefined) {
    const covered = await prisma.purchaseSpend.findFirst({
      where: {
        agentId,
        provider: { not: MERCHANT_SAVED_PROVIDER },
        status: { in: AGENTCARD_COVERED_STATUSES },
        createdAt: { gte: new Date(Date.now() - AGENTCARD_LOOKBACK_MS) },
      },
      select: { id: true },
    });
    if (covered !== null) {
      log.info('Skipping facilitated GMV; AgentCard purchase already covers agent', {
        agentId,
        purchaseId: covered.id,
      });
      return { status: 'skipped', reason: 'agentcard_purchase_exists' };
    }
  }

  const fingerprint = buildFacilitatedFingerprint(input);
  const existing = await prisma.purchaseSpend.findFirst({
    where: { userId: input.userId, fingerprint },
    select: { id: true },
  });
  if (existing !== null) {
    return { status: 'recorded', purchaseId: existing.id, created: false };
  }

  const lineItemsJson: Prisma.InputJsonValue = {
    currency: input.currency ?? 'USD',
    lineItems: (Array.isArray(input.lineItems) ? input.lineItems : []) as Prisma.InputJsonValue,
    fees: [] as Prisma.InputJsonValue,
    subtotalCents: input.totalCents,
    totalCents: input.totalCents,
    paymentMethod: input.paymentMethod ?? '',
    totals: (input.totals ?? {}) as Prisma.InputJsonValue,
    source: MERCHANT_SAVED_PROVIDER,
    domain: input.domain ?? '',
  };

  const purchase = await prisma.purchaseSpend.create({
    data: {
      userId: input.userId,
      agentId,
      fingerprint,
      canonicalFingerprint: fingerprint,
      merchant,
      lineItemsJson,
      totalCents: input.totalCents,
      status: PurchaseSpendStatus.CLEARED,
      provider: MERCHANT_SAVED_PROVIDER,
    },
    select: { id: true },
  });

  log.info('Recorded facilitated GMV', {
    purchaseId: purchase.id,
    userId: input.userId,
    agentId,
    merchant,
    totalCents: input.totalCents,
  });

  return { status: 'recorded', purchaseId: purchase.id, created: true };
}
