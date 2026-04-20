/**
 * Back-compat barrel. The i-message-sync domain was refactored into
 * main/domains/i-message-sync/. External callers (SyncManager, handlers/registry,
 * and the blackbox test file — which is read-only under the refactor skill) still
 * import from this path; that's fine — everything below re-exports the runtime.
 */
export { IMessageSync } from '../domains/i-message-sync/runtime';
