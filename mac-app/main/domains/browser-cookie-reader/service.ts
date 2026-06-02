/**
 * Service layer for browser-cookie-reader.
 *
 * Houses the pure decryption + row-mapping logic (no I/O) and the
 * orchestrators that stitch the repo primitives (path resolution, keychain
 * read, DB copy+query, cleanup) into the three public operations:
 *
 *   - listInstalledBrowsers(): filesystem probe across every supported
 *     browser, returns only those whose cookies DB resolves.
 *   - findBrowserConfig(type): lookup in the static config map.
 *   - readBrowserCookies(type, config?): full pipeline — resolve path →
 *     acquire AES key (keychain CLI or manual password) → copy+query DB →
 *     decrypt rows → map to CookieData.
 *
 * Contract notes:
 *   - `readBrowserCookies` returns [] when the cookies file is missing
 *     (best-effort reader; not a hard requirement).
 *   - Keychain errors bubble up with a helpful prefix (misconfigured Safe
 *     Storage is unrecoverable here and should surface to the UI).
 *   - Rows with empty/malformed/undecryptable payloads are skipped rather
 *     than aborting the whole batch.
 *   - If >10 rows are present and <10% decrypt, we infer a wrong password
 *     and throw — relevant for Atlas's manual-password flow.
 */

import crypto from 'crypto';
import path from 'path';
import {
  AES_BLOCK_SIZE,
  BROWSER_COOKIE_READER_LOG_PREFIX,
  CHROME_PREFIX_LENGTH,
  V10_PREFIX,
  WRONG_PASSWORD_ROW_THRESHOLD,
  WRONG_PASSWORD_SUCCESS_RATIO,
  getBrowserConfigs,
} from './config';
import {
  deriveAesKey,
  fetchKeychainPassword,
  openCookiesDbCopy,
  readSafariCookieFile,
  resolveCookiePath,
  resolveCookiePaths,
} from './repo';
import { parseSafariBinaryCookies } from './safariCookies';
import type {
  BrowserProfileMetadata,
  BrowserConfig,
  BrowserInfo,
  BrowserType,
  CookieData,
  CookieRow,
  ReadCookiesConfig,
} from './types';

/**
 * Remove PKCS7 padding from decrypted data. Invalid padding is left intact
 * so the caller can decide whether to drop the whole value — we never want
 * to silently produce a truncated string from a bogus trailer.
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
 * Validate that a decrypted string looks like a real cookie value. Cookie
 * values are typically printable ASCII or valid UTF-8; control characters
 * (except tab), DEL, and the Unicode replacement character signal a bad
 * key / corrupt row.
 */
function isValidCookieValue(value: string): boolean {
  if (value === '') return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    // Allow printable ASCII (32-126), tab (9), and valid UTF-8 continuation.
    if (code < 32 && code !== 9) return false;
    if (code === 127) return false; // DEL character.
    // Replacement character indicates invalid UTF-8 decoding.
    if (code === 0xfffd) return false;
  }
  return true;
}

/**
 * Decrypt a Chromium Safe Storage cookie value using AES-128-CBC with the
 * fixed 16-space IV. Returns null when the ciphertext is empty, truncated,
 * or otherwise undecryptable — the caller drops those rows instead of
 * aborting the batch. Plaintext ASCII values (non-v10 prefix) are returned
 * as-is to match legacy behavior.
 */
export function decryptCookieValue(encryptedValue: Buffer, key: Buffer): string | null {
  if (encryptedValue.length === 0) {
    return null;
  }

  const prefix = encryptedValue.slice(0, V10_PREFIX.length).toString();
  if (prefix !== V10_PREFIX) {
    // Could be unencrypted (plaintext) or an unknown version.
    const asString = encryptedValue.toString('utf8');
    if (asString !== '' && /^[\x20-\x7E]*$/.test(asString)) {
      return asString; // Appears to be plaintext ASCII.
    }
    return null;
  }

  // v10 format: 3-byte prefix + ciphertext; need at least one byte of payload.
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
      const value = unpadded.slice(CHROME_PREFIX_LENGTH).toString('utf8');
      // Validate the decrypted value looks like a real cookie value.
      if (isValidCookieValue(value)) {
        return value;
      }
      return null;
    }

    // Payload was only the random prefix — treat as empty.
    return '';
  } catch {
    return null; // Decryption failed (corrupt row / wrong key).
  }
}

/**
 * Map a raw SQLite row + its decrypted value into the shared IPC
 * `CookieData` shape. Coerces SQLite 0/1 ints into booleans and a null
 * `top_frame_site_key` into an empty string (the backend expects a string).
 */
export function mapRowToCookieData(
  row: CookieRow,
  value: string,
  browserProfile?: BrowserProfileMetadata
): CookieData {
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
    ...(browserProfile !== undefined ? { browserProfile } : {}),
  };
}

function getProfileMetadataFromCookiePath(cookiePath: string): BrowserProfileMetadata {
  const profilePath = path.dirname(cookiePath);
  if (path.basename(profilePath) === 'Network') {
    return path.basename(path.dirname(profilePath));
  }
  return path.basename(profilePath);
}

function resolveCookiePathsForRead(browser: BrowserConfig): string[] {
  if (browser.type === 'chrome') {
    const legacyPaths = resolveCookiePaths(browser.cookiePathPattern);
    const networkCookiePattern = path.join(
      path.dirname(browser.cookiePathPattern),
      'Network',
      'Cookies'
    );
    const networkPaths = resolveCookiePaths(networkCookiePattern);
    return Array.from(new Set([...legacyPaths, ...networkPaths]));
  }
  const cookiePath = resolveCookiePath(browser.cookiePathPattern);
  return cookiePath === null ? [] : [cookiePath];
}

function resolveInstalledCookiePath(browser: BrowserConfig): string | null {
  if (browser.type !== 'chrome') {
    return resolveCookiePath(browser.cookiePathPattern);
  }
  return resolveCookiePathsForRead(browser)[0] ?? null;
}

function cookieKey(cookie: CookieData): string {
  return `${cookie.browserProfile ?? ''}\u0000${cookie.host_key}\u0000${cookie.name}\u0000${cookie.path}\u0000${cookie.top_frame_site_key}`;
}

function isCookieNewer(candidate: CookieData, existing: CookieData): boolean {
  const candidateTimestamps = [
    candidate.last_update_utc ?? 0,
    candidate.last_access_utc ?? 0,
    candidate.creation_utc ?? 0,
    candidate.expires_utc ?? 0,
  ];
  const existingTimestamps = [
    existing.last_update_utc ?? 0,
    existing.last_access_utc ?? 0,
    existing.creation_utc ?? 0,
    existing.expires_utc ?? 0,
  ];

  for (let i = 0; i < candidateTimestamps.length; i++) {
    if (candidateTimestamps[i] !== existingTimestamps[i]) {
      return candidateTimestamps[i] > existingTimestamps[i];
    }
  }
  return false;
}

function deduplicateCookiesByIdentity(cookies: CookieData[]): CookieData[] {
  const byIdentity = new Map<string, CookieData>();
  for (const cookie of cookies) {
    const key = cookieKey(cookie);
    const existing = byIdentity.get(key);
    if (existing === undefined || isCookieNewer(cookie, existing)) {
      byIdentity.set(key, cookie);
    }
  }
  return Array.from(byIdentity.values());
}

/**
 * Return the static per-browser config for a known type, or null for an
 * unrecognized type.
 */
export function findBrowserConfig(browserType: BrowserType): BrowserConfig | null {
  return getBrowserConfigs()[browserType] ?? null;
}

/**
 * Probe each supported browser's cookie-path pattern against the filesystem
 * and return only those that resolve. Each result carries the resolved path
 * so the caller can skip another glob when reading cookies.
 */
export function listInstalledBrowsers(): BrowserInfo[] {
  const results = Object.values(getBrowserConfigs()).map((browser): BrowserInfo => {
    const resolvedPath = resolveInstalledCookiePath(browser);
    console.log(
      `${BROWSER_COOKIE_READER_LOG_PREFIX} Checking ${browser.name}: pattern=${browser.cookiePathPattern}, resolved=${resolvedPath}`
    );
    return {
      ...browser,
      isInstalled: resolvedPath !== null,
      resolvedCookiePath: resolvedPath ?? undefined,
    };
  });
  const installed = results.filter((b) => b.isInstalled);
  console.log(
    `${BROWSER_COOKIE_READER_LOG_PREFIX} Found ${installed.length} installed browsers:`,
    installed.map((b) => b.type)
  );
  return installed;
}

/**
 * Acquire the AES key for a browser. Chromium-family browsers go through
 * the macOS Keychain CLI; Atlas (and any other Data Protection keychain
 * browser) requires the user to supply the password manually.
 */
async function acquireBrowserKey(
  browser: BrowserConfig,
  config: ReadCookiesConfig | undefined
): Promise<Buffer> {
  let password: string;

  if (browser.needsManualPassword) {
    if (config?.keychainPassword === undefined || config.keychainPassword === '') {
      throw new Error(
        `${browser.name} requires a keychain password. ` +
          `Please provide the password from "${browser.keychainEntry}" in Keychain Access.`
      );
    }
    password = config.keychainPassword;
  } else {
    try {
      password = await fetchKeychainPassword(browser.keychainAccount);
    } catch {
      throw new Error(
        `Failed to get ${browser.name} encryption key from keychain. ` +
          `Make sure ${browser.name} is installed and has been run at least once.`
      );
    }
  }

  return deriveAesKey(password);
}

/**
 * Full read pipeline for a single browser: resolve path → acquire AES key →
 * copy+query DB → decrypt each row → map to CookieData. Returns an empty
 * list when the browser isn't installed. Always cleans up the DB handle +
 * temp copy via `handle.close()`.
 */
export async function readBrowserCookies(
  browserType: BrowserType,
  config?: ReadCookiesConfig
): Promise<CookieData[]> {
  const browser = getBrowserConfigs()[browserType];
  if (browser === undefined) {
    throw new Error(`Unknown browser type: ${browserType}`);
  }

  const cookiePaths = resolveCookiePathsForRead(browser);
  if (cookiePaths.length === 0) {
    console.log(`${BROWSER_COOKIE_READER_LOG_PREFIX} ${browser.name} cookies file not found`);
    return [];
  }

  if (browser.cookieStore === 'safariBinary') {
    const cookies = parseSafariBinaryCookies(readSafariCookieFile(cookiePaths[0]));
    console.log(
      `${BROWSER_COOKIE_READER_LOG_PREFIX} Read ${cookies.length} ${browser.name} cookies`
    );
    return cookies;
  }

  let key: Buffer | null = null;
  const cookies: CookieData[] = [];
  let skipped = 0;
  let totalCookies = 0;

  for (const cookiePath of cookiePaths) {
    const handle = openCookiesDbCopy(cookiePath, browserType);
    try {
      if (key === null) {
        key = await acquireBrowserKey(browser, config);
      }
      const rows = handle.queryCookieRows();
      totalCookies += rows.length;
      const browserProfile =
        browserType === 'chrome' ? getProfileMetadataFromCookiePath(cookiePath) : undefined;

      for (const row of rows) {
        const value = decryptCookieValue(row.encrypted_value, key);
        if (value === null || value === '') {
          skipped++;
          continue;
        }
        cookies.push(mapRowToCookieData(row, value, browserProfile));
      }
    } finally {
      handle.close();
    }
  }

  const deduplicatedCookies =
    browserType === 'chrome' ? deduplicateCookiesByIdentity(cookies) : cookies;

  // Wrong-password heuristic: with a meaningful row count but near-zero
  // decryption success, the user's password is almost certainly wrong.
  const successRate = totalCookies > 0 ? cookies.length / totalCookies : 0;
  if (totalCookies > WRONG_PASSWORD_ROW_THRESHOLD && successRate < WRONG_PASSWORD_SUCCESS_RATIO) {
    throw new Error(
      `Failed to decrypt ${browser.name} cookies. ` +
        `The keychain password may be incorrect. ` +
        `(${cookies.length}/${totalCookies} cookies decrypted successfully)`
    );
  }

  console.log(
    `${BROWSER_COOKIE_READER_LOG_PREFIX} Read ${deduplicatedCookies.length} ${browser.name} cookies ` +
      `(skipped ${skipped} unreadable)`
  );
  return deduplicatedCookies;
}
