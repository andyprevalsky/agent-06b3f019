/**
 * Runtime layer for atlas-credential-store.
 *
 * Exposes the static `AtlasCredentialStore` class that IPC handlers and tests
 * invoke. Keeps the public surface area identical to the pre-refactor flat
 * file so wiring, mocks, and the blackbox test don't need to change.
 *
 * Responsibilities:
 *   - Preserve the four-method static API
 *   - Delegate all business logic to ./service
 */

import * as service from './service';
import type { ClearPasswordResult, StorePasswordResult } from './types';

/**
 * Securely stores the Atlas (ChatGPT) keychain password using Electron's
 * safeStorage API.
 *
 * The password is encrypted using macOS Keychain-backed encryption and stored
 * locally. It never leaves the user's computer and is only used to decrypt
 * Atlas cookies for sync.
 */
export class AtlasCredentialStore {
  /** Whether Electron's safeStorage encryption is available on this system. */
  static isEncryptionAvailable(): boolean {
    return service.isEncryptionAvailable();
  }

  /**
   * Store the Atlas keychain password securely.
   * The password is encrypted using the OS keychain before being written to disk.
   */
  static storePassword(password: string): StorePasswordResult {
    return service.storePassword(password);
  }

  /**
   * Retrieve the stored Atlas keychain password.
   * Returns null if no password is stored or decryption fails.
   */
  static getPassword(): string | null {
    return service.getPassword();
  }

  /** Whether a password is currently stored. */
  static hasPassword(): boolean {
    return service.hasPassword();
  }

  /** Clear the stored password. */
  static clearPassword(): ClearPasswordResult {
    return service.clearPassword();
  }
}
