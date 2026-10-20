/**
 * Deterministic Message ids for client-retried writes.
 *
 * A message kind listed here carries `metadata.idempotencyKey`; its row id is
 * derived from (agentId, key), so a retried create hits the primary key and
 * returns the first row instead of writing a duplicate:
 *   - USER response-schema updates (`isResponseSchemaUpdate`)
 *   - direct-chat turns typed to a code session (`isDirectCodeTurn`,
 *     claude-code domain `sendDirectTurn`)
 */
import { createHash } from 'node:crypto';
import type { CreateMessageParams } from './messages';
import { stringMetadataValue } from './toolLifecycleMessages';

function hasIdempotentKind(params: CreateMessageParams): boolean {
  if (params.role === 'USER') return params.metadata?.isResponseSchemaUpdate === true;
  return params.role === 'TOOL' && params.metadata?.isDirectCodeTurn === true;
}

export function idempotentMessageId(params: CreateMessageParams): string | null {
  if (!hasIdempotentKind(params)) return null;
  const key = stringMetadataValue(params.metadata, 'idempotencyKey');
  if (key === null) return null;
  const hex = createHash('sha256').update(`${params.agentId}:${key}`).digest('hex').slice(0, 32);
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}
