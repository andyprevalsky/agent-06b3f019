import type { CookieData } from '../../../shared/types/ipc';

/**
 * Supported browser credential sources the multi-browser reader knows how to
 * import. Chromium-family browsers use SQLite + Safe Storage; Safari uses
 * Cookies.binarycookies. Distinct from `shared/types/ipc`'s `BrowserType` in
 * name only — the union must stay in lockstep with that shared alias.
 */
export type BrowserType =
  'chrome' | 'edge' | 'brave' | 'arc' | 'opera' | 'vivaldi' | 'chromium' | 'atlas' | 'safari';

/**
 * Static, per-browser wiring: where cookies live on disk, how the store is
 * encoded, the macOS Keychain entry for Chromium Safe Storage when relevant,
 * and whether the user must supply the password manually.
 */
export interface BrowserConfig {
  type: BrowserType;
  name: string;
  cookiePathPattern: string;
  keychainEntry: string;
  keychainAccount: string;
  needsManualPassword: boolean;
  cookieStore: 'sqlite' | 'safariBinary';
}

/**
 * `BrowserConfig` augmented with the result of probing the filesystem:
 * whether the browser is installed and, if so, the resolved cookie-store path.
 */
export interface BrowserInfo extends BrowserConfig {
  isInstalled: boolean;
  resolvedCookiePath?: string;
}

/**
 * Call-site options for `readCookies`. Only used by browsers with
 * `needsManualPassword: true` (e.g. Atlas) — Chrome and friends read the
 * password from the macOS Keychain CLI.
 */
export interface ReadCookiesConfig {
  keychainPassword?: string;
}

export type BrowserProfileMetadata = string;

/**
 * Raw row shape returned by the Chromium `cookies` SQLite table. Mirrors
 * the columns the reader actually consumes; additional columns on the real
 * schema are intentionally left untyped because the reader never reads them.
 *
 * `encrypted_value` is the binary ciphertext produced by Safe Storage
 * (AES-128-CBC with the `v10` prefix on macOS).
 */
export interface CookieRow {
  host_key: string;
  name: string;
  encrypted_value: Buffer;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  creation_utc: number;
  top_frame_site_key: string | null;
  last_access_utc: number;
  has_expires: number;
  is_persistent: number;
  priority: number;
  samesite: number;
  source_scheme: number;
  source_port: number;
  last_update_utc: number;
}

/**
 * Re-export the shared IPC cookie shape so downstream layers (repo/service/
 * runtime) import a single domain-local type module rather than reaching
 * across the tree for `shared/types/ipc`.
 */
export type { CookieData };
