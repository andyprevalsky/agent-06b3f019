/**
 * Types for browser-password-reader.
 *
 * Supported Chromium-family browsers and the data shapes the reader emits
 * (decrypted PasswordData plus the RSA-2048 + AES-256-GCM envelope used to
 * safely ship passwords off-device).
 */

/**
 * Supported Chromium-family browsers whose saved-password store the reader
 * knows how to decrypt on macOS. Atlas requires manual keychain password
 * entry (it uses the "ChatGPT Safe Storage" Data Protection keychain).
 */
export type BrowserType =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'arc'
  | 'opera'
  | 'vivaldi'
  | 'chromium'
  | 'atlas';

/**
 * Static per-browser wiring: where `Login Data` lives on disk, the macOS
 * Keychain entry that holds the Safe Storage password, and the account
 * name used with `security(1)`.
 */
export interface BrowserConfig {
  type: BrowserType;
  name: string;
  loginDataPathPattern: string;
  keychainEntry: string;
  keychainAccount: string;
}

/**
 * `BrowserConfig` augmented with the result of probing the filesystem.
 */
export interface BrowserInfo extends BrowserConfig {
  isInstalled: boolean;
  resolvedLoginDataPath?: string;
}

/**
 * Call-site options for `readPasswords` / `readAndEncryptPasswords`. Only
 * used by browsers whose Safe Storage password cannot be fetched via the
 * `security(1)` CLI (e.g. Atlas) or when the caller wants to supply a
 * known password directly.
 */
export interface ReadPasswordsConfig {
  keychainPassword?: string;
}

export type BrowserProfileMetadata = string;

/**
 * A single decrypted password row.
 *
 * `dateLastUsed` / `dateCreated` are Chromium timestamps (microseconds
 * since 1601-01-01 UTC). The reader never converts them — that's the
 * caller's concern.
 */
export interface PasswordData {
  origin: string;
  username: string;
  password: string;
  dateLastUsed: number;
  dateCreated: number;
  browserSource: string;
  browserProfile?: BrowserProfileMetadata;
}

/**
 * Encrypted password envelope for safe storage / transport. Uses the same
 * RSA-2048 + AES-256-GCM hybrid pattern as payment encryption. The
 * corresponding RSA private key lives on the agent workers as
 * `PAYMENT_DECRYPTION_KEY`.
 */
export interface EncryptedPasswordEnvelope {
  version: 1;
  encrypted_aes_key: string;
  iv: string;
  ciphertext: string;
}

/**
 * Raw row shape returned by the Chromium `logins` SQLite table. Mirrors the
 * columns the reader actually consumes; extra columns on the real schema
 * are intentionally left untyped because the reader never reads them.
 *
 * `password_value` is the binary ciphertext produced by Safe Storage
 * (AES-128-CBC with the `v10` prefix on macOS).
 */
export interface LoginRow {
  origin_url: string;
  username_value: string;
  password_value: Buffer;
  date_last_used: number;
  date_created: number;
}
