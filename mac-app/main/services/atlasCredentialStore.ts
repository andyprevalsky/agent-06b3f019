import { app, safeStorage } from 'electron';
import fs from 'fs';
import path from 'path';

const CREDENTIAL_FILE = 'atlas-keychain.enc';

/**
 * Securely stores the Atlas (ChatGPT) keychain password using Electron's safeStorage API.
 *
 * The password is encrypted using macOS Keychain-backed encryption and stored locally.
 * It never leaves the user's computer and is only used to decrypt Atlas cookies for sync.
 */
export class AtlasCredentialStore {
  private static getCredentialPath(): string {
    return path.join(app.getPath('userData'), CREDENTIAL_FILE);
  }

  /**
   * Check if safeStorage encryption is available on this system.
   */
  static isEncryptionAvailable(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  /**
   * Store the Atlas keychain password securely.
   * The password is encrypted using the OS keychain before being written to disk.
   */
  static storePassword(password: string): { success: boolean; error?: string } {
    if (!this.isEncryptionAvailable()) {
      return { success: false, error: 'Encryption not available on this system' };
    }

    try {
      const encrypted = safeStorage.encryptString(password);
      const credPath = this.getCredentialPath();
      fs.writeFileSync(credPath, encrypted);
      console.log('[AtlasCredentialStore] Password stored securely');
      return { success: true };
    } catch (error) {
      console.error('[AtlasCredentialStore] Failed to store password:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to store password',
      };
    }
  }

  /**
   * Retrieve the stored Atlas keychain password.
   * Returns null if no password is stored or decryption fails.
   */
  static getPassword(): string | null {
    if (!this.isEncryptionAvailable()) {
      return null;
    }

    try {
      const credPath = this.getCredentialPath();
      if (!fs.existsSync(credPath)) {
        return null;
      }

      const encrypted = fs.readFileSync(credPath);
      const password = safeStorage.decryptString(encrypted);
      return password;
    } catch (error) {
      console.error('[AtlasCredentialStore] Failed to retrieve password:', error);
      return null;
    }
  }

  /**
   * Check if a password is currently stored.
   */
  static hasPassword(): boolean {
    try {
      const credPath = this.getCredentialPath();
      return fs.existsSync(credPath);
    } catch {
      return false;
    }
  }

  /**
   * Clear the stored password.
   */
  static clearPassword(): { success: boolean } {
    try {
      const credPath = this.getCredentialPath();
      if (fs.existsSync(credPath)) {
        fs.unlinkSync(credPath);
        console.log('[AtlasCredentialStore] Password cleared');
      }
      return { success: true };
    } catch (error) {
      console.error('[AtlasCredentialStore] Failed to clear password:', error);
      return { success: false };
    }
  }
}
