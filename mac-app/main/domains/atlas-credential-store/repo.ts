/**
 * Repo layer for atlas-credential-store.
 *
 * Owns every side-effecting boundary the domain touches:
 *   - Electron `app.getPath('userData')` for the credential directory
 *   - Electron `safeStorage` for macOS-Keychain-backed encrypt/decrypt
 *   - `fs` for reading/writing/removing the credential file
 *
 * Service layer never shells out or touches the filesystem directly — it goes
 * through these named, typed functions.
 */

import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';
import { CREDENTIAL_FILE } from './config';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Absolute path of the credential file under Electron's `userData` directory. */
export function getCredentialPath(): string {
  return path.join(app.getPath('userData'), CREDENTIAL_FILE);
}

// ---------------------------------------------------------------------------
// safeStorage primitives
// ---------------------------------------------------------------------------

/** Whether Electron's safeStorage encryption is available on this system. */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/** Encrypt a UTF-8 string via Electron's safeStorage (macOS-Keychain-backed). */
export function encryptString(plaintext: string): Buffer {
  return safeStorage.encryptString(plaintext);
}

/** Decrypt a safeStorage ciphertext buffer back to its UTF-8 plaintext. */
export function decryptString(ciphertext: Buffer): string {
  return safeStorage.decryptString(ciphertext);
}

// ---------------------------------------------------------------------------
// Filesystem primitives
// ---------------------------------------------------------------------------

/** Whether the credential file currently exists at the configured path. */
export function credentialFileExists(): boolean {
  return fs.existsSync(getCredentialPath());
}

/** Write an encrypted buffer to the credential file (overwrites any existing file). */
export function writeCredentialFile(encrypted: Buffer): void {
  fs.writeFileSync(getCredentialPath(), encrypted);
}

/** Read the encrypted credential file from disk. */
export function readCredentialFile(): Buffer {
  return fs.readFileSync(getCredentialPath());
}

/** Remove the credential file from disk. */
export function deleteCredentialFile(): void {
  fs.unlinkSync(getCredentialPath());
}
