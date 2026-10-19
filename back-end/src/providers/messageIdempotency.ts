/** Deterministic message ids for keyed USER writes (retry-safe inserts). */

import { createHash } from 'node:crypto';
import { stringMetadataValue } from './toolLifecycleMessages';

interface IdempotentMessageParams {
  agentId: string;
  role: string;
  metadata?: Record<string, unknown> | null;
}

/** Key namespace per keyed USER kind; response-schema rows keep the legacy empty one. */
function keyNamespace(metadata: Record<string, unknown> | null | undefined): string {
  if (metadata?.agentMessage === true) return 'agent-message:';
  if (metadata?.agentNotification === true) return 'agent-notification:';
  if (metadata?.environmentContext === true) return 'environment-context:';
  return '';
}

/**
 * Deterministic row id for keyed USER writes, so a retried request lands on
 * one primary-key lookup instead of a JSON scan of the agent's messages.
 * Agent-to-agent messages, background-agent notifications and environment
 * context rows use their own key namespaces.
 */
export function idempotentMessageId(params: IdempotentMessageParams): string | null {
  const namespace = keyNamespace(params.metadata);
  const keyed = namespace !== '' || params.metadata?.isResponseSchemaUpdate === true;
  const key = stringMetadataValue(params.metadata, 'idempotencyKey');
  if (params.role !== 'USER' || !keyed || key === null) return null;
  const seed = `${params.agentId}:${namespace}${key}`;
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}
