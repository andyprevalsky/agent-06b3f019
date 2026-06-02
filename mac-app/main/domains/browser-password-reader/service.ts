/**
 * Service layer for browser-password-reader.
 *
 * Houses the pure decryption + envelope logic (no I/O) and the orchestrators
 * that stitch repo primitives (path resolution, keychain read, DB copy+query,
 * cleanup) into the public operations:
 *
 *   - listInstalledBrowsers(): filesystem probe across every supported
 *     browser, returns only those whose Login Data resolves.
 *   - findBrowserConfig(type): lookup in the static config map.
 *   - readPasswords(type, config?): full pipeline — resolve path → acquire
 *     AES key (keychain CLI or manual password) → copy+query DB → decrypt
 *     rows → map to PasswordData.
 *   - encryptPassword(plain): RSA-2048 + AES-256-GCM hybrid envelope.
 *   - readAndEncryptPasswords(type, config?): readPasswords followed by
 *     per-entry envelope generation; returns the plaintext-stripped shape.
 */

import crypto from 'crypto';
import {
  AES_BLOCK_SIZE,
  AES_GCM_IV_LENGTH,
  AES_GCM_KEY_LENGTH,
  BROWSER_PASSWORD_READER_LOG_PREFIX,
  RSA_PUBLIC_KEY_PEM,
  V10_PREFIX,
  getBrowserConfigs,
} from './config';
import {
  deriveAesKey,
  fetchKeychainPassword,
  openLoginsDbCopy,
  resolveLoginDataPath,
  resolveLoginDataPaths,
} from './repo';
import type {
  BrowserProfileMetadata,
  BrowserConfig,
  BrowserInfo,
  BrowserType,
  EncryptedPasswordEnvelope,
  LoginRow,
  PasswordData,
  ReadPasswordsConfig,
} from './types';
import path from 'path';

/**
 * Remove PKCS7 padding from decrypted data. Invalid padding is left intact
 * so the caller's validator can drop the whole value — we never want to
 * silently produce a truncated string from a bogus trailer.
 */
function removePkcs7Padding(data: Buffer): Buffer {
  if (data.length === 0) return data;
  const paddingLength = data[data.length - 1];
  if (paddingLength > AES_BLOCK_SIZE || paddingLength > data.length) {
    return data;
  }
  for (let i = data.length - paddingLength; i < data.length; i++) {
    if (data[i] !== paddingLength) {
      return data;
    }
  }
  return data.slice(0, data.length - paddingLength);
}

/**
 * Validate that a decrypted password looks plausible. Wrong-key decryptions
 * produce garbage bytes that reliably fail this check. Allows printable
 * ASCII plus common Latin extended ranges (accented letters, etc.).
 */
function isPlausiblePassword(password: string): boolean {
  return /^[\x20-\x7E\u00A0-\u00FF\u0100-\u017F]*$/.test(password);
}

/**
 * Decrypt a Chromium Safe Storage password value using AES-128-CBC with the
 * fixed 16-space IV. Unlike cookies, password values do NOT carry a 32-byte
 * random prefix — the decrypted bytes ARE the password directly.
 *
 * Returns null for empty, truncated, undecryptable, or implausibly-valued
 * rows. Plaintext ASCII values (non-v10 prefix) are returned as-is to match
 * legacy behavior on older login DBs.
 */
export function decryptPasswordValue(encryptedValue: Buffer, key: Buffer): string | null {
  if (encryptedValue.length === 0) {
    return null;
  }

  const prefix = encryptedValue.slice(0, V10_PREFIX.length).toString();
  if (prefix !== V10_PREFIX) {
    const asString = encryptedValue.toString('utf8');
    if (asString !== '' && /^[\x20-\x7E]*$/.test(asString)) {
      return asString;
    }
    return null;
  }

  if (encryptedValue.length < V10_PREFIX.length + 1) {
    return null;
  }

  try {
    const iv = Buffer.alloc(AES_BLOCK_SIZE, ' ');
    const ciphertext = encryptedValue.slice(V10_PREFIX.length);

    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    decipher.setAutoPadding(false);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const unpadded = removePkcs7Padding(decrypted);

    const password = unpadded.toString('utf8');
    if (!isPlausiblePassword(password)) {
      return null;
    }
    return password;
  } catch {
    return null;
  }
}

/**
 * Encrypt a password using RSA-2048-OAEP + AES-256-GCM hybrid encryption
 * and return the base64-encoded envelope. Envelope is JSON-encoded then
 * base64-wrapped so it can travel through string-only channels.
 */
export async function encryptPasswordToEnvelope(password: string): Promise<string> {
  const aesKey = crypto.randomBytes(AES_GCM_KEY_LENGTH);
  const iv = crypto.randomBytes(AES_GCM_IV_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  const encryptedAesKey = crypto.publicEncrypt(
    {
      key: RSA_PUBLIC_KEY_PEM,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );

  const envelope: EncryptedPasswordEnvelope = {
    version: 1,
    encrypted_aes_key: encryptedAesKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };

  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

/**
 * Map a raw `logins` row + its decrypted password into the public shape.
 * Null / 0 timestamps are both coerced to 0 (the reader treats them as
 * absent) — matches the legacy `|| 0` semantics on older DBs that stored
 * `NULL` for never-used entries.
 */
function mapRowToPasswordData(
  row: LoginRow,
  password: string,
  browserType: BrowserType,
  browserProfile?: BrowserProfileMetadata
): PasswordData {
  return {
    origin: row.origin_url,
    username: row.username_value,
    password,
    dateLastUsed: row.date_last_used ?? 0,
    dateCreated: row.date_created ?? 0,
    browserSource: browserType,
    ...(browserProfile !== undefined ? { browserProfile } : {}),
  };
}

function getProfileMetadataFromLoginDataPath(loginDataPath: string): BrowserProfileMetadata {
  const profilePath = path.dirname(loginDataPath);
  return path.basename(profilePath);
}

function resolveLoginDataPathsForRead(browser: BrowserConfig): string[] {
  if (browser.type === 'chrome') {
    return resolveLoginDataPaths(browser.loginDataPathPattern);
  }
  const loginDataPath = resolveLoginDataPath(browser.loginDataPathPattern);
  return loginDataPath === null ? [] : [loginDataPath];
}

function passwordKey(password: PasswordData): string {
  return `${password.origin}\u0000${password.username}`;
}

function isPasswordNewer(candidate: PasswordData, existing: PasswordData): boolean {
  const candidateLastUsed = candidate.dateLastUsed ?? 0;
  const existingLastUsed = existing.dateLastUsed ?? 0;
  if (candidateLastUsed !== existingLastUsed) {
    return candidateLastUsed > existingLastUsed;
  }
  return (candidate.dateCreated ?? 0) > (existing.dateCreated ?? 0);
}

function deduplicatePasswordsByCredential(passwords: PasswordData[]): PasswordData[] {
  const byCredential = new Map<string, PasswordData>();
  for (const password of passwords) {
    const key = passwordKey(password);
    const existing = byCredential.get(key);
    if (existing === undefined || isPasswordNewer(password, existing)) {
      byCredential.set(key, password);
    }
  }
  return Array.from(byCredential.values());
}

/**
 * Return the static per-browser config for a known type, or null for an
 * unrecognized type.
 */
export function findBrowserConfig(browserType: BrowserType): BrowserConfig | null {
  return getBrowserConfigs()[browserType] ?? null;
}

/**
 * Probe each supported browser's login-data-path pattern against the
 * filesystem and return only those that resolve. Each result carries the
 * resolved path so the caller can skip another glob when reading.
 */
export function listInstalledBrowsers(): BrowserInfo[] {
  const results = Object.values(getBrowserConfigs()).map((browser): BrowserInfo => {
    const resolvedPath = resolveLoginDataPath(browser.loginDataPathPattern);
    console.log(
      `${BROWSER_PASSWORD_READER_LOG_PREFIX} Checking ${browser.name}: pattern=${browser.loginDataPathPattern}, resolved=${resolvedPath}`
    );
    return {
      ...browser,
      isInstalled: resolvedPath !== null,
      resolvedLoginDataPath: resolvedPath ?? undefined,
    };
  });
  const installed = results.filter((b) => b.isInstalled);
  console.log(
    `${BROWSER_PASSWORD_READER_LOG_PREFIX} Found ${installed.length} installed browsers with Login Data:`,
    installed.map((b) => b.type)
  );
  return installed;
}

/**
 * Acquire the AES key for a browser. When the caller supplies a manual
 * password we use it directly; otherwise we consult the macOS Keychain via
 * the `security(1)` CLI and wrap any failure in an install-hint error.
 */
async function acquireBrowserKey(
  browser: BrowserConfig,
  manualPassword: string | undefined
): Promise<Buffer> {
  let password: string;

  console.log(
    `${BROWSER_PASSWORD_READER_LOG_PREFIX} getEncryptionKey called for ${browser.name}, manualPassword provided: ${manualPassword !== undefined}`
  );

  if (manualPassword !== undefined) {
    console.log(
      `${BROWSER_PASSWORD_READER_LOG_PREFIX} Using manual password (length: ${manualPassword.length})`
    );
    password = manualPassword;
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
 * Full read pipeline for a single browser: resolve path → copy+open DB →
 * acquire AES key → decrypt each row → map to PasswordData. Returns [] when
 * the browser isn't installed. Always cleans up the DB handle + temp copy
 * via `handle.close()`, including when key acquisition throws.
 */
export async function readPasswordsForBrowser(
  browserType: BrowserType,
  config?: ReadPasswordsConfig
): Promise<PasswordData[]> {
  const browser = getBrowserConfigs()[browserType];
  if (browser === undefined) {
    throw new Error(`Unknown browser type: ${browserType}`);
  }

  const loginDataPaths = resolveLoginDataPathsForRead(browser);
  if (loginDataPaths.length === 0) {
    console.log(`${BROWSER_PASSWORD_READER_LOG_PREFIX} ${browser.name} Login Data file not found`);
    return [];
  }

  let key: Buffer | null = null;
  const passwords: PasswordData[] = [];
  let emptyEntries = 0;
  let decryptionFailures = 0;

  for (const loginDataPath of loginDataPaths) {
    // Copy+open the DB before acquiring the key so that a keychain failure
    // still hits the cleanup path (matches the original service's behavior).
    const handle = openLoginsDbCopy(loginDataPath, browserType);

    try {
      if (key === null) {
        key = await acquireBrowserKey(browser, config?.keychainPassword);
      }

      const rows = handle.queryLoginRows();
      const browserProfile =
        browserType === 'chrome' ? getProfileMetadataFromLoginDataPath(loginDataPath) : undefined;

      for (const row of rows) {
        if (row.username_value === '' || row.password_value.length === 0) {
          emptyEntries++;
          continue;
        }

        const password = decryptPasswordValue(row.password_value, key);
        if (password === null || password === '') {
          decryptionFailures++;
          continue;
        }

        passwords.push(mapRowToPasswordData(row, password, browserType, browserProfile));
      }
    } finally {
      handle.close();
    }
  }

  const deduplicatedPasswords =
    browserType === 'chrome' ? deduplicatePasswordsByCredential(passwords) : passwords;

  console.log(
    `${BROWSER_PASSWORD_READER_LOG_PREFIX} Read ${deduplicatedPasswords.length} ${browser.name} passwords ` +
      `(empty: ${emptyEntries}, decryption failures: ${decryptionFailures})`
  );

  // If we had encrypted entries but ALL decryption failed AND a manual
  // password was supplied, the caller almost certainly typed it wrong.
  if (
    deduplicatedPasswords.length === 0 &&
    decryptionFailures > 0 &&
    config?.keychainPassword !== undefined
  ) {
    throw new Error(
      'Failed to decrypt passwords. Please check that you entered the correct keychain password.'
    );
  }

  return deduplicatedPasswords;
}

/**
 * Read passwords and replace each plaintext value with the RSA-OAEP +
 * AES-GCM envelope. The returned shape drops `password` and adds
 * `encryptedPassword` — callers that need plaintext must use
 * `readPasswordsForBrowser` directly.
 */
export async function readAndEncryptPasswordsForBrowser(
  browserType: BrowserType,
  config?: ReadPasswordsConfig
): Promise<Array<Omit<PasswordData, 'password'> & { encryptedPassword: string }>> {
  const passwords = await readPasswordsForBrowser(browserType, config);

  const encryptedPasswords = await Promise.all(
    passwords.map(async (p) => {
      const encryptedPassword = await encryptPasswordToEnvelope(p.password);
      return {
        origin: p.origin,
        username: p.username,
        encryptedPassword,
        dateLastUsed: p.dateLastUsed,
        dateCreated: p.dateCreated,
        browserSource: p.browserSource,
        ...(p.browserProfile !== undefined ? { browserProfile: p.browserProfile } : {}),
      };
    })
  );

  console.log(
    `${BROWSER_PASSWORD_READER_LOG_PREFIX} Encrypted ${encryptedPasswords.length} passwords for upload`
  );
  return encryptedPasswords;
}
