/**
 * Legacy import path. The browser-cookie-reader domain now lives under
 * `main/domains/browser-cookie-reader/`. This module re-exports the
 * domain's runtime entry so existing call sites (blackbox test mocks,
 * handlers/registry, browser-state-sync service) keep working without
 * edits.
 */
export { BrowserCookieReader } from '../domains/browser-cookie-reader/runtime';
export type {
  BrowserConfig,
  BrowserInfo,
  BrowserType,
  ReadCookiesConfig,
} from '../domains/browser-cookie-reader/runtime';
