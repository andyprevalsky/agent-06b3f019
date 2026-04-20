/**
 * Legacy import path. The cookie-reader domain now lives under
 * `main/domains/cookie-reader/`. This module re-exports the domain's runtime
 * entry so existing call sites (blackbox test mocks, handlers/registry,
 * cookie-sync repo) keep working without edits.
 */
export { CookieReader } from '../domains/cookie-reader/runtime';
