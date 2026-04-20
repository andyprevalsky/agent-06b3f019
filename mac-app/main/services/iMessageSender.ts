/**
 * Legacy entry path for the i-message-sender domain.
 *
 * The implementation lives in `main/domains/i-message-sender/`; this shim
 * preserves the pre-refactor import path for callers (i-message-queue-service
 * repo, blackbox tests) without forcing them to update their imports.
 *
 * New code should import from 'main/domains/i-message-sender/runtime'.
 */

export { IMessageSender } from '../domains/i-message-sender/runtime';
export type { IMessagePayload } from '../domains/i-message-sender/runtime';
