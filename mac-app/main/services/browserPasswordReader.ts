/**
 * Legacy import path. The browser-password-reader domain now lives under
 * `main/domains/browser-password-reader/`. This module re-exports the
 * domain's runtime entry so existing call sites (blackbox test mocks,
 * browser-state-sync service) keep working without edits.
 */
export { BrowserPasswordReader } from '../domains/browser-password-reader/runtime';
export type {
  BrowserConfig,
  BrowserInfo,
  BrowserType,
  EncryptedPasswordEnvelope,
  PasswordData,
  ReadPasswordsConfig,
} from '../domains/browser-password-reader/runtime';
