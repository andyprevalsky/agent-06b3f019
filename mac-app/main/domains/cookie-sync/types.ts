import type { AuthSession, CookieData, UploadResult } from '../../../shared/types/ipc';

/**
 * Result of a cookie-sync run. Represents the observable outcome of
 * `CookieSync.sync()` for callers or future handlers that want to branch on
 * it. The current runtime discards this value, but typing it here keeps the
 * service layer honest.
 */
export type CookieSyncOutcome =
  | { status: 'skipped'; reason: 'unauthenticated' | 'disconnected' | 'empty' }
  | { status: 'uploaded'; count: number; success: boolean; message?: string }
  | { status: 'errored'; error: unknown };

/**
 * Re-exports of upstream shared types used by the cookie-sync domain layers.
 * Keeping them here (instead of repeatedly importing from `shared/types/ipc`)
 * means repo/service/runtime import from a single domain-local type module.
 */
export type { AuthSession, CookieData, UploadResult };
