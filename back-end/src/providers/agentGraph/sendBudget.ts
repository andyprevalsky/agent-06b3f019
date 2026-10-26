/**
 * Per-sender send budget for the agent graph: a token bucket keyed by the
 * sending agent / code agent id, so one runaway sender (a CLI loop, an A ⇄ B
 * echo) is capped while every other sender keeps its own full budget.
 *
 *   takeSendBudget(senderId) ─┬─ token left → { ok: true }
 *                             └─ empty      → { ok: false, retryAfterSeconds }
 *
 * 10k agents: O(1) per send, no DB, no shared lock; memory is bounded by
 * MAX_TRACKED_SENDERS (least-recently-used senders are dropped, and a dropped
 * sender simply starts again with a full bucket). The budget is per backend
 * instance, which is enough to stop a flood without a cross-instance store.
 */

/** Messages a sender may send back to back. */
export const SEND_BURST = 60;
/** Sustained rate once the burst is spent. */
export const SEND_REFILL_PER_SECOND = 1;
export const MAX_TRACKED_SENDERS = 20_000;

interface Bucket {
  tokens: number;
  updatedAtMs: number;
}

const buckets = new Map<string, Bucket>();

export type SendBudget = { ok: true } | { ok: false; retryAfterSeconds: number };

export function takeSendBudget(senderId: string, nowMs: number = Date.now()): SendBudget {
  const previous = buckets.get(senderId);
  const tokens =
    previous === undefined
      ? SEND_BURST
      : Math.min(
          SEND_BURST,
          previous.tokens + ((nowMs - previous.updatedAtMs) / 1000) * SEND_REFILL_PER_SECOND
        );
  const allowed = tokens >= 1;
  // Re-insert so the Map's iteration order is least-recently-used first.
  buckets.delete(senderId);
  buckets.set(senderId, { tokens: allowed ? tokens - 1 : tokens, updatedAtMs: nowMs });
  while (buckets.size > MAX_TRACKED_SENDERS) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
  if (allowed) return { ok: true };
  return { ok: false, retryAfterSeconds: Math.ceil((1 - tokens) / SEND_REFILL_PER_SECOND) };
}

/** Senders currently tracked (bounded by MAX_TRACKED_SENDERS). */
export function trackedSenders(): number {
  return buckets.size;
}
