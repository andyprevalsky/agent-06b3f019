/**
 * Types for the atlas-credential-store domain.
 *
 * The store persists the user's Atlas (ChatGPT) keychain password on disk,
 * encrypted via Electron's `safeStorage`. Only two result shapes surface
 * outside the domain — store and clear results.
 */

/** Shape returned by `storePassword` — success flag with an optional error message. */
export interface StorePasswordResult {
  success: boolean;
  error?: string;
}

/** Shape returned by `clearPassword` — success flag only (errors are swallowed and logged). */
export interface ClearPasswordResult {
  success: boolean;
}
