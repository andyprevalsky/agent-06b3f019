/** Deterministic Message row ids for idempotent writes. */
import { createHash } from 'node:crypto';

export function deterministicMessageId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/** Row id of an agent-to-agent message: one row per (recipient agent, key). */
export function agentGraphMessageRowId(agentId: string, a2aMessageId: string): string {
  return deterministicMessageId(`${agentId}:a2a:${a2aMessageId}`);
}
