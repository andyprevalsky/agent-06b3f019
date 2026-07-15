/**
 * i-message-queue-service — config layer
 *
 * Domain-local constants. Env-backed URLs live in main/base/config.ts and are
 * consumed inside repo.ts.
 */

/**
 * How often the polling loop wakes up to check the backend queue.
 */
export const POLL_INTERVAL_MS = 10 * 1000;

/** Encrypted local receipt store used to survive a backend ACK outage. */
export const DELIVERY_MARKER_STORE_NAME = 'navi-imessage-delivery-markers';

/**
 * Relative path of the backend queue-pop endpoint.
 */
export const QUEUE_POP_PATH = '/api/imessage/queue/pop';

export function queueResultPath(queueId: string): string {
  return `/api/imessage/queue/${encodeURIComponent(queueId)}/result`;
}

/**
 * Component tag used in log lines emitted by this domain.
 */
export const LOG_TAG = 'IMessageQueueService';
