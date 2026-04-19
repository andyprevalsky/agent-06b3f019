/**
 * Back-compat barrel. The i-message-queue-service domain was refactored into
 * main/domains/i-message-queue-service/. External callers (SyncManager runtime
 * and the blackbox test file — which is read-only under the refactor skill)
 * still import from this path; that's fine — the re-export below delegates to
 * the runtime layer.
 */
export { IMessageQueueService } from '../domains/i-message-queue-service/runtime';
