/**
 * i-message-queue-service — types layer
 *
 * Wire types for the backend queue-pop endpoint plus the domain's internal
 * view of a queued iMessage.
 */

/**
 * Single message popped off the backend queue.
 */
export interface QueuedMessage {
  id: string;
  phone_number: string;
  message: string;
  agent_id: string;
  created_at: string;
}

/**
 * Response shape of `GET /api/imessage/queue/pop`. `message` is `null` when the
 * queue is empty.
 */
export interface PopResponse {
  message: QueuedMessage | null;
}

/**
 * Subset of the authenticated session shape the queue domain reads.
 */
export interface Session {
  access_token: string;
}

/**
 * Result of a single queue pop attempt.
 *
 * - `ok: true` — response parsed; `data.message` is either a queued row or
 *   `null` when the queue is empty.
 * - `ok: false` — backend returned a non-2xx status; caller should log + exit
 *   the drain loop without crashing.
 */
export type PopOutcome =
  { ok: true; data: PopResponse } | { ok: false; status: number; statusText: string };
