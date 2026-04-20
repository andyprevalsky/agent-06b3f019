/**
 * Public entry point for browser-password-reader. External callers
 * (browser-state-sync service, blackbox test mocks) use `BrowserPasswordReader.*`
 * — the class shape is preserved for backward compatibility with the legacy
 * `main/services/browserPasswordReader.ts` import surface.
 *
 * The runtime layer is intentionally thin: it delegates the full flow to
 * the service layer. All decryption, I/O, and logging live behind the
 * service / repo split.
 */

import {
  encryptPasswordToEnvelope,
  findBrowserConfig,
  listInstalledBrowsers,
  readAndEncryptPasswordsForBrowser,
  readPasswordsForBrowser,
} from './service';
import type {
  BrowserConfig,
  BrowserInfo,
  BrowserType,
  EncryptedPasswordEnvelope,
  PasswordData,
  ReadPasswordsConfig,
} from './types';

export type {
  BrowserConfig,
  BrowserInfo,
  BrowserType,
  EncryptedPasswordEnvelope,
  PasswordData,
  ReadPasswordsConfig,
};

/**
 * BrowserPasswordReader provides multi-browser password reading support.
 *
 * Reads saved passwords from Chromium-based browsers, decrypts them locally,
 * then re-encrypts with RSA-2048 + AES-256-GCM for secure storage.
 *
 * Supported browsers: Chrome, Edge, Brave, Arc, Opera, Vivaldi, Chromium,
 * ChatGPT Atlas (Atlas requires manual keychain password entry).
 */
export class BrowserPasswordReader {
  /** List installed browsers on this machine, with resolved login-data paths. */
  static getInstalledBrowsers(): BrowserInfo[] {
    return listInstalledBrowsers();
  }

  /** Fetch the static per-browser config, or null if the type is unknown. */
  static getBrowserConfig(browserType: BrowserType): BrowserConfig | null {
    return findBrowserConfig(browserType);
  }

  /**
   * Encrypt a password using RSA-2048 + AES-256-GCM hybrid encryption.
   * Returns a base64-encoded envelope.
   */
  static async encryptPassword(password: string): Promise<string> {
    return encryptPasswordToEnvelope(password);
  }

  /**
   * Read + decrypt passwords from a specific browser.
   *
   * @param browserType - Chromium-family browser identifier.
   * @param config      - Required for Atlas (keychainPassword); optional otherwise.
   * @returns Array of password data with decrypted passwords.
   */
  static async readPasswords(
    browserType: BrowserType,
    config?: ReadPasswordsConfig
  ): Promise<PasswordData[]> {
    return readPasswordsForBrowser(browserType, config);
  }

  /**
   * Read and encrypt passwords from a browser. Returns entries with the
   * password field replaced by an RSA-encrypted envelope.
   */
  static async readAndEncryptPasswords(
    browserType: BrowserType,
    config?: ReadPasswordsConfig
  ): Promise<Array<Omit<PasswordData, 'password'> & { encryptedPassword: string }>> {
    return readAndEncryptPasswordsForBrowser(browserType, config);
  }
}
