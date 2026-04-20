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

/**
 * Relative path of the backend queue-pop endpoint.
 */
export const QUEUE_POP_PATH = '/api/imessage/queue/pop';

/**
 * Component tag used in log lines emitted by this domain.
 */
export const LOG_TAG = 'IMessageQueueService';
