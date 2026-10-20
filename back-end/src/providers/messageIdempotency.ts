/**
 * Deterministic message ids for keyed writes. A retried write with the same
 * (agent, key) computes the same primary key, so it is found before insert or
 * loses the race with P2002 instead of creating a second row.
 *
 *   USER  + metadata.isResponseSchemaUpdate + idempotencyKey   (schema updates)
 *   ASSISTANT + metadata.source === 'display' + idempotencyKey (display media)
 */
import { createHash } from 'node:crypto';
import { stringMetadataValue } from './toolLifecycleMessages';

export function deterministicMessageId(agentId: string, key: string): string {
  const hex = createHash('sha256').update(`${agentId}:${key}`).digest('hex').slice(0, 32);
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function idempotentMessageId(params: {
  agentId: string;
  role: string;
  metadata?: Record<string, unknown> | null;
}): string | null {
  const keyed =
    (params.role === 'ASSISTANT' && params.metadata?.source === 'display') ||
    (params.role === 'USER' && params.metadata?.isResponseSchemaUpdate === true);
  if (!keyed) return null;
  const key = stringMetadataValue(params.metadata, 'idempotencyKey');
  return key === null ? null : deterministicMessageId(params.agentId, key);
}
