/**
 * Deterministic Message ids for client-retried writes.
 *
 * A message kind listed here carries `metadata.idempotencyKey`; its row id is
 * derived from (agentId, key), so a retried create hits the primary key and
 * returns the first row instead of writing a duplicate:
 *   - USER response-schema updates (`isResponseSchemaUpdate`)
 *   - direct-chat turns typed to a code session (`isDirectCodeTurn`,
 *     claude-code domain `sendDirectTurn`)
 *   - structured transcript batches of a code session (`isCodeTranscript`,
 *     agents `save_code_transcript_batch`, keyed by task + event range)
 *   - agent-graph (A2A) messages (`a2a` metadata, agents domain
 *     `agentGraphService`): the recipient's USER row and the code agent's
 *     sent/received chip rows
 */
import { createHash } from 'node:crypto';
import type { CreateMessageParams } from './messages';
import { stringMetadataValue } from './toolLifecycleMessages';

function isAgentGraphMessage(params: CreateMessageParams): boolean {
  const a2a = params.metadata?.a2a;
  return typeof a2a === 'object' && a2a !== null && !Array.isArray(a2a);
}

function hasIdempotentKind(params: CreateMessageParams): boolean {
  if (isAgentGraphMessage(params)) return params.role === 'USER' || params.role === 'TOOL';
  if (params.role === 'USER') return params.metadata?.isResponseSchemaUpdate === true;
  if (params.role !== 'TOOL') return false;
  return params.metadata?.isDirectCodeTurn === true || params.metadata?.isCodeTranscript === true;
}

/** Row id for one (agent, key) write. */
export function deterministicMessageId(agentId: string, key: string): string {
  const hex = createHash('sha256').update(`${agentId}:${key}`).digest('hex').slice(0, 32);
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function idempotentMessageId(params: CreateMessageParams): string | null {
  if (!hasIdempotentKind(params)) return null;
  const key = stringMetadataValue(params.metadata, 'idempotencyKey');
  if (key === null) return null;
  return deterministicMessageId(params.agentId, key);
}
