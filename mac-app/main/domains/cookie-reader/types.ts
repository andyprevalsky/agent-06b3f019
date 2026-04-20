import type { CookieData } from '../../../shared/types/ipc';

/**
 * Raw row shape returned by the Chrome `cookies` SQLite table. Only the
 * columns the reader actually consumes are modeled here — everything else on
 * the real schema is left untyped because we never read it.
 *
 * `encrypted_value` is the binary ciphertext produced by Chrome's Safe
 * Storage (typically AES-128-CBC with the `v10` prefix on macOS).
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
