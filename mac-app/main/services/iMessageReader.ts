/**
 * Back-compat barrel. The i-message-reader domain was refactored into
 * main/domains/i-message-reader/. External callers (main/index.ts,
 * main/handlers/registry.ts, main/domains/i-message-sync/repo.ts, and the
 * blackbox test files — which are read-only under the refactor skill) still
 * import from this path; that's fine — this re-exports the runtime.
 */
export { IMessageReader } from '../domains/i-message-reader/runtime';
