/**
 * Compatibility shim — the browser-state-sync domain was refactored into
 * main/domains/browser-state-sync/. This file re-exports the runtime façade
 * so existing callers (handlers/registry.ts, sync/SyncManager.ts) and
 * blackbox tests keep working without path churn.
 *
 * New code should import from 'main/domains/browser-state-sync/runtime'.
 */
export { BrowserStateSync } from '../domains/browser-state-sync/runtime';
