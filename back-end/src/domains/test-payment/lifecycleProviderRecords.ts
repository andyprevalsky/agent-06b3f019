import { TestPaymentError } from './errors';
import type { TestPaymentLifecycle } from './types';

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

export function mcpResultRows(result: unknown, field: string): Record<string, unknown>[] {
  const record = mcpResultRecord(result);
  const values = record[field];
  if (!Array.isArray(values)) {
    throw new TestPaymentError(`AgentCard lifecycle response missing ${field}`, 502);
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
