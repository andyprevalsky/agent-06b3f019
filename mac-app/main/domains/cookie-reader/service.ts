/**
 * Service layer for cookie-reader.
 *
 * Houses the pure decryption + row-mapping logic (no I/O) and the orchestrator
 * that stitches the repo primitives (profile resolution, keychain key, DB
 * copy+query, cleanup) into a single `readAllCookies()` call.
 *
 * Contract:
 *   - Returns an empty list if Chrome is not installed / no profile was found
 *     (the domain is a best-effort reader, not a hard requirement).
 *   - Propagates keychain errors to the caller (misconfigured Safe Storage is
 *     unrecoverable here and should surface to the UI).
 *   - Silently skips cookies with empty, malformed, or undecryptable payloads
 *     rather than aborting the whole batch.
 */

import crypto from 'crypto';
import {
  AES_BLOCK_SIZE,
  CHROME_PREFIX_LENGTH,
  COOKIE_READER_LOG_PREFIX,
  V10_PREFIX,
} from './config';
import { fetchChromeEncryptionKey, findChromeCookiesPath, openCookiesDbCopy } from './repo';
import type { CookieData, CookieRow } from './types';

/**
 * Remove PKCS7 padding from decrypted data. Invalid padding is left intact so
 * the caller can decide whether to drop the whole value — we never want to
 * silently produce a truncated string from a bogus trailer.
 */
function removePkcs7Padding(data: Buffer): Buffer {
  if (data.length === 0) return data;
  const paddingLength = data[data.length - 1];
  if (paddingLength > AES_BLOCK_SIZE || paddingLength > data.length) {
    return data; // Invalid padding, return as-is.
  }
  for (let i = data.length - paddingLength; i < data.length; i++) {
    if (data[i] !== paddingLength) {
      return data; // Invalid padding, return as-is.
    }
  }
  return data.slice(0, data.length - paddingLength);
}

/**
 * Decrypt a Chrome cookie value using AES-128-CBC with the fixed 16-space IV.
 * Returns null when the ciphertext is empty, truncated, or otherwise
 * undecryptable — the caller drops those rows instead of aborting the batch.
 * Plaintext ASCII values (non-v10 prefix) are returned as-is to match the
 * legacy reader's behavior.
 */
export function decryptChromeCookieValue(encryptedValue: Buffer, key: Buffer): string | null {
  if (encryptedValue.length === 0) {
    return null;
  }

  // Check for the v10 Chrome-on-macOS prefix.
  const prefix = encryptedValue.slice(0, V10_PREFIX.length).toString();
  if (prefix !== V10_PREFIX) {
    // Could be unencrypted (plaintext) or an unknown version.
    const asString = encryptedValue.toString('utf8');
    if (asString !== '' && /^[\x20-\x7E]*$/.test(asString)) {
      return asString; // Appears to be plaintext ASCII.
    }
    return null;
  }

  // v10 format: 3-byte prefix + ciphertext; need at least one block.
  if (encryptedValue.length < V10_PREFIX.length + 1) {
    return null;
  }

  try {
    const iv = Buffer.alloc(AES_BLOCK_SIZE, ' ');
    const ciphertext = encryptedValue.slice(V10_PREFIX.length);

    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false); // Handled manually below.

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const unpadded = removePkcs7Padding(decrypted);

    // Chrome prepends 32 random bytes before the real value — skip them.
    if (unpadded.length > CHROME_PREFIX_LENGTH) {
      return unpadded.slice(CHROME_PREFIX_LENGTH).toString('utf8');
    }

    // Payload was only the random prefix — treat as empty.
    return '';
  } catch {
    return null; // Decryption failed (corrupt row / wrong key).
  }
}

/**
 * Map a raw SQLite row + its decrypted value into the shared IPC `CookieData`
 * shape. Coerces SQLite 0/1 ints into booleans and null `top_frame_site_key`
 * into an empty string (the backend expects a present string).
 */
export function mapRowToCookieData(row: CookieRow, value: string): CookieData {
  return {
    host_key: row.host_key,
    name: row.name,
    value,
    path: row.path,
    expires_utc: row.expires_utc,
    is_secure: row.is_secure === 1,
    is_httponly: row.is_httponly === 1,
    creation_utc: row.creation_utc,
    top_frame_site_key: row.top_frame_site_key ?? '',
    last_access_utc: row.last_access_utc,
    has_expires: row.has_expires === 1,
    is_persistent: row.is_persistent === 1,
    priority: row.priority,
    samesite: row.samesite,
    source_scheme: row.source_scheme,
    source_port: row.source_port,
    last_update_utc: row.last_update_utc,
  };
}

/**
 * Orchestrator: resolve profile → copy DB → load keychain key → decrypt each
 * row → map to CookieData. Returns an empty list when Chrome isn't installed.
 * Always cleans up the DB handle + temp copy via `handle.close()`.
 */
export async function readAllCookies(): Promise<CookieData[]> {
  const cookiesPath = findChromeCookiesPath();
  if (cookiesPath === null) {
    console.log(`${COOKIE_READER_LOG_PREFIX} Chrome cookies file not found`);
    return [];
  }

  const handle = openCookiesDbCopy(cookiesPath);
  try {
    const key = await fetchChromeEncryptionKey();
    const rows = handle.queryCookieRows();
    const cookies: CookieData[] = [];
    let skipped = 0;

    for (const row of rows) {
      const value = decryptChromeCookieValue(row.encrypted_value, key);
      if (value === null || value === '') {
        skipped++;
        continue;
      }
      cookies.push(mapRowToCookieData(row, value));
    }

    console.log(
      `${COOKIE_READER_LOG_PREFIX} Read ${cookies.length} cookies (skipped ${skipped} unreadable)`
    );
    return cookies;
  } finally {
    handle.close();
  }
}
