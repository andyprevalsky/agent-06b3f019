/**
 * Legacy import path. The cookie-sync domain now lives under
 * `main/domains/cookie-sync/`. This module re-exports the domain's runtime
 * entry so existing call sites (blackbox test mocks, SyncManager,
 * handlers/registry) keep working without edits.
 */
export { CookieSync } from '../domains/cookie-sync/runtime';
