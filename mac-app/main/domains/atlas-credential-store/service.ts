/**
 * Service layer for atlas-credential-store.
 *
 * Orchestrates the encrypt-on-write / decrypt-on-read flow:
 *   - `storePassword`   → encrypt via safeStorage, write to disk
 *   - `getPassword`     → read from disk, decrypt via safeStorage
 *   - `hasPassword`     → check disk for the credential file
 *   - `clearPassword`   → remove the credential file
 *
 * Every failure mode is caught, logged, and shaped into a result — the service
 * never throws. All I/O flows through the repo layer.
 */

import { LOG_PREFIX } from './config';
import {
  credentialFileExists,
  decryptString,
  deleteCredentialFile,
  encryptString,
  isEncryptionAvailable as repoIsEncryptionAvailable,
  readCredentialFile,
  writeCredentialFile,
} from './repo';
import type { ClearPasswordResult, StorePasswordResult } from './types';

/** Whether Electron's safeStorage encryption is available on this system. */
export function isEncryptionAvailable(): boolean {
  return repoIsEncryptionAvailable();
}

/**
 * Store the Atlas keychain password securely.
 * Returns `{ success: false, error }` when encryption is unavailable, the
 * encrypt call throws, or the disk write fails.
 */
export function storePassword(password: string): StorePasswordResult {
  if (!repoIsEncryptionAvailable()) {
    return { success: false, error: 'Encryption not available on this system' };
  }

  try {
    const encrypted = encryptString(password);
    writeCredentialFile(encrypted);
    console.log(`${LOG_PREFIX} Password stored securely`);
    return { success: true };
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to store password:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to store password',
    };
  }
}

/**
 * Retrieve the stored Atlas keychain password.
 * Returns `null` when encryption is unavailable, no file is stored, or
 * either the disk read or the decrypt call throws.
 */
export function getPassword(): string | null {
  if (!repoIsEncryptionAvailable()) {
    return null;
  }

  try {
    if (!credentialFileExists()) {
      return null;
    }
    const encrypted = readCredentialFile();
    return decryptString(encrypted);
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to retrieve password:`, error);
    return null;
  }
}

/** Whether a password is currently persisted on disk. Swallows fs errors. */
export function hasPassword(): boolean {
  try {
    return credentialFileExists();
  } catch {
    return false;
  }
}

/**
 * Remove the stored password. Idempotent — succeeds even when no file exists.
 * Returns `{ success: false }` only when the unlink itself throws.
 */
export function clearPassword(): ClearPasswordResult {
  try {
    if (credentialFileExists()) {
      deleteCredentialFile();
      console.log(`${LOG_PREFIX} Password cleared`);
    }
    return { success: true };
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to clear password:`, error);
    return { success: false };
  }
}
