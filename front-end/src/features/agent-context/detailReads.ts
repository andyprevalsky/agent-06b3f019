/**
 * In-flight agent-detail reads, keyed by agent id.
 *
 * Opening a trajectory starts the selection's GET /agents/:id while the
 * realtime join is still pending, and the disconnected backfill's 300ms poll
 * would otherwise start an identical full-trajectory read beside it (another
 * download, JSON parse and message merge of the same rows). The poll consults
 * this registry and skips a tick while a recent read of the same agent is in
 * flight; that read's owner applies the result, and the next tick polls as
 * usual if the channel is still down. Reads older than the caller's bound do
 * not suppress anything, so a hung request never disables the fallback.
 *
 * Scale: one entry per in-flight read of the selected agent; O(1) per check.
 */

const reads = new Map<string, Map<symbol, number>>();

/** Register a detail read; call the returned function when it settles. */
export function beginAgentDetailRead(agentId: string, now: number = Date.now()): () => void {
  const token = Symbol(agentId);
  let agentReads = reads.get(agentId);
  if (!agentReads) {
    agentReads = new Map();
    reads.set(agentId, agentReads);
  }
  agentReads.set(token, now);
  return () => {
    const current = reads.get(agentId);
    if (!current) return;
    current.delete(token);
    if (current.size === 0) reads.delete(agentId);
  };
}

/** True while a read of this agent started less than `maxAgeMs` ago is in flight. */
export function hasRecentAgentDetailRead(
  agentId: string,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  const agentReads = reads.get(agentId);
  if (!agentReads) return false;
  for (const startedAt of agentReads.values()) {
    if (now - startedAt < maxAgeMs) return true;
  }
  return false;
}
