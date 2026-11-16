import { TestPaymentError } from './errors';
import type { TestPaymentLifecycle } from './types';
import type { LifecycleAttention, StripeHold } from './lifecycleDependencies';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertMcpSuccess(record: Record<string, unknown>): void {
  if (record.isError === true) {
    throw new TestPaymentError('AgentCard lifecycle request returned an error', 502);
  }
}

function contentRecord(record: Record<string, unknown>): Record<string, unknown> {
  const content = Array.isArray(record.content) ? record.content : [];
  const text = content
    .map((part) => asRecord(part))
    .filter((part): part is Record<string, unknown> => part !== undefined)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
  if (text !== '') {
    try {
      const parsed = asRecord(JSON.parse(text));
      if (parsed !== undefined) return parsed;
    } catch {
      throw new TestPaymentError('AgentCard lifecycle response was invalid', 502);
    }
  }
  throw new TestPaymentError('AgentCard lifecycle response was invalid', 502);
}

function nestedMcpResultCode(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (typeof record.code === 'string' && record.code.trim() !== '') return record.code.trim();
  for (const key of ['error', 'toolResult', 'structuredContent']) {
    const code = nestedMcpResultCode(record[key], depth + 1);
    if (code !== undefined) return code;
  }
  const content = Array.isArray(record.content) ? record.content : [];
  for (const part of content) {
    const text = asRecord(part)?.text;
    if (typeof text !== 'string' || text.trim() === '') continue;
    try {
      const code = nestedMcpResultCode(JSON.parse(text), depth + 1);
      if (code !== undefined) return code;
    } catch {
      // Non-JSON MCP text is handled by the normal result parser.
    }
  }
  return undefined;
}

export function mcpResultCode(result: unknown): string | undefined {
  return nestedMcpResultCode(result);
}

export function mcpResultRecord(result: unknown): Record<string, unknown> {
  const envelope = asRecord(result);
  if (envelope === undefined) {
    throw new TestPaymentError('AgentCard lifecycle response was invalid', 502);
  }
  assertMcpSuccess(envelope);
  const toolResult = asRecord(envelope.toolResult);
  if (toolResult !== undefined) {
    assertMcpSuccess(toolResult);
    const structured = asRecord(toolResult.structuredContent);
    if (structured !== undefined) return structured;
    if ('content' in toolResult) return contentRecord(toolResult);
    return toolResult;
  }
  const structured = asRecord(envelope.structuredContent);
  if (structured !== undefined) return structured;
  return contentRecord(envelope);
}

export function agentCardSummaryFromMcpResult(result: unknown): {
  status: string;
  balanceCents: number;
} {
  if (mcpResultCode(result)?.toLowerCase() === 'card_closed') {
    return { status: 'closed', balanceCents: 0 };
  }
  const record = mcpResultRecord(result);
  const card = asRecord(record.card) ?? record;
  const status = card.status;
  const balanceCents = card.balanceCents ?? card.balance_cents;
  if (typeof status !== 'string' || status === '') {
    throw new TestPaymentError('AgentCard card lifecycle missing status', 502);
  }
  if (typeof balanceCents !== 'number' || !Number.isInteger(balanceCents)) {
    throw new TestPaymentError('AgentCard card lifecycle missing balanceCents', 502);
  }
  return { status, balanceCents };
}

export function mcpResultRows(result: unknown, field: string): Record<string, unknown>[] {
  const record = mcpResultRecord(result);
  const values = record[field];
  if (!Array.isArray(values)) {
    // Throttled/errored list calls come back as a bare message with no rows; keep it so the
    // 502 names the provider cause instead of only the absent field.
    const providerMessage =
      typeof record.message === 'string' ? record.message.trim().slice(0, 200) : '';
    throw new TestPaymentError(
      `AgentCard lifecycle response missing ${field}${providerMessage ? `: ${providerMessage}` : ''}`,
      502
    );
  }
  return values.map((value, index) => {
    const row = asRecord(value);
    if (row === undefined) {
      throw new TestPaymentError(`AgentCard ${field} lifecycle row ${index} was invalid`, 502);
    }
    if (typeof row.id !== 'string' || row.id.trim() === '') {
      throw new TestPaymentError(`AgentCard ${field} lifecycle row ${index} missing id`, 502);
    }
    return row;
  });
}

export function integerField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TestPaymentError(`AgentCard transfer lifecycle missing ${key}`, 502);
  }
  return value;
}

export function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new TestPaymentError(`AgentCard transfer lifecycle missing ${key}`, 502);
  }
  return value;
}

function providerRows(results: unknown[], field: string): Record<string, unknown>[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const result of results) {
    for (const row of mcpResultRows(result, field)) {
      byId.set(row.id as string, row);
    }
  }
  return [...byId.values()];
}

function createdDuringPurchase(value: unknown, purchaseCreatedAt: Date): boolean {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= purchaseCreatedAt.getTime() - 5_000;
}

export function mapStripeHold(hold: StripeHold | null): TestPaymentLifecycle['stripeHold'] {
  if (hold === null) return null;
  return {
    id: hold.id,
    livemode: hold.livemode,
    status: hold.status,
    amountCents: hold.amount,
    amountCapturableCents: hold.amount_capturable,
    amountReceivedCents: hold.amount_received,
  };
}

/**
 * Stripe Search is eventually consistent: a hold placed seconds earlier can be missing from
 * `metadata['agentId']` results. The purchase's own payment intent is read directly (strongly
 * consistent), so union it in; search still proves no additional intents exist.
 */
export function withKnownStripeIntent(
  stripeResults: { data: Array<{ id: string }> },
  knownIntent: { id: string } | null
): { data: Array<{ id: string }> } {
  return knownIntent === null
    ? stripeResults
    : { data: [...stripeResults.data, { id: knownIntent.id }] };
}

export function providerIntegrity(
  purchase: { totalCents: number; createdAt: Date },
  cardholderId: string | undefined,
  stripeResults: { data: Array<{ id: string }> },
  cardResults: unknown[],
  transferResults: unknown[]
): Pick<
  TestPaymentLifecycle['integrity'],
  | 'stripeProviderPaymentIntentCount'
  | 'agentCardProviderCardCount'
  | 'agentCardProviderTransferCount'
  | 'agentCardProviderUnlinkedTransferCount'
> {
  const cards =
    cardholderId === undefined
      ? []
      : providerRows(cardResults, 'cards').filter(
          (card) =>
            card.cardholderId === cardholderId &&
            card.spendLimitCents === purchase.totalCents &&
            createdDuringPurchase(card.createdAt, purchase.createdAt)
        );
  const transfers =
    cardholderId === undefined
      ? []
      : providerRows(transferResults, 'transfers').filter(
          (transfer) =>
            transfer.cardholder_id === cardholderId &&
            transfer.amount_cents === purchase.totalCents &&
            createdDuringPurchase(transfer.created_at, purchase.createdAt)
        );
  return {
    stripeProviderPaymentIntentCount: new Set(stripeResults.data.map((intent) => intent.id)).size,
    agentCardProviderCardCount: cards.length,
    agentCardProviderTransferCount: transfers.length,
    agentCardProviderUnlinkedTransferCount: transfers.filter(
      (transfer) => typeof transfer.card_id !== 'string' || transfer.card_id === ''
    ).length,
  };
}

function attentionKind(metadata: unknown): string | null {
  const value = asRecord(metadata)?.attentionKind;
  return typeof value === 'string' && value !== '' ? value : null;
}

export function buildAttention(
  attentionRequests: LifecycleAttention
): TestPaymentLifecycle['attention'] {
  const kinds = attentionRequests
    .map((request) => ({
      kind: attentionKind(request.metadata),
      open: request.userResponse === null,
    }))
    .filter((entry): entry is { kind: string; open: boolean } => entry.kind !== null);
  return {
    openKinds: kinds.filter((entry) => entry.open).map((entry) => entry.kind),
    resolvedKinds: kinds.filter((entry) => !entry.open).map((entry) => entry.kind),
  };
}

export function mapAgentCard(
  purchase: { cardId: string | null },
  cardDetails: { status: string; balanceCents: number } | null
): TestPaymentLifecycle['agentCard'] {
  if (cardDetails === null || purchase.cardId === null) return null;
  return {
    id: purchase.cardId,
    status: cardDetails.status,
    balanceCents: cardDetails.balanceCents,
  };
}
