/**
 * messaging-whatsapp: repo layer
 *
 * Filesystem-backed persistence for Baileys' multi-file auth state, plus helpers
 * that parse the credentials file for the linked phone number. No business logic;
 * just typed data access against `fs` and `path`.
 */
import fs from 'fs';
import path from 'path';
import { WHATSAPP_CREDS_BACKUP_FILE, WHATSAPP_CREDS_FILE, getWhatsAppAuthDir } from './config';
import { jidToPhone } from './normalize';
import type { WhatsAppCredsFile } from './types';

/**
 * WhatsApp authentication state management.
 * Uses Baileys' multi-file auth state with backup/restore capability.
 */
export class WhatsAppAuth {
  /**
   * Get the auth directory path.
   */
  static getAuthDir(): string {
    return getWhatsAppAuthDir();
  }

  /**
   * Ensure auth directory exists. Idempotent.
   */
  static ensureAuthDir(): void {
    const dir = getWhatsAppAuthDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Check if credentials exist and are valid JSON with non-trivial content.
   */
  static hasCredentials(): boolean {
    const credsPath = path.join(getWhatsAppAuthDir(), WHATSAPP_CREDS_FILE);
    try {
      if (!fs.existsSync(credsPath)) return false;
      const stats = fs.statSync(credsPath);
      if (!stats.isFile() || stats.size <= 1) return false;
      const raw = fs.readFileSync(credsPath, 'utf-8');
      JSON.parse(raw); // Validate JSON
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Attempt to restore credentials from backup if main creds are corrupted.
   * Returns true only when an actual restore happened.
   */
  static maybeRestoreFromBackup(): boolean {
    const dir = getWhatsAppAuthDir();
    const credsPath = path.join(dir, WHATSAPP_CREDS_FILE);
    const backupPath = path.join(dir, WHATSAPP_CREDS_BACKUP_FILE);

    try {
      // Check if main creds are valid
      if (fs.existsSync(credsPath)) {
        const raw = fs.readFileSync(credsPath, 'utf-8');
        JSON.parse(raw);
        return false; // Creds are valid, no restore needed
      }
    } catch {
      // Main creds are corrupted or missing — fall through to restore
    }

    // Try to restore from backup
    try {
      if (!fs.existsSync(backupPath)) return false;
      const backupRaw = fs.readFileSync(backupPath, 'utf-8');
      JSON.parse(backupRaw); // Validate backup
      fs.copyFileSync(backupPath, credsPath);
      console.log('[WhatsAppAuth] Restored credentials from backup');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a backup of current credentials. No-op on missing/invalid creds.
   */
  static backupCredentials(): void {
    const dir = getWhatsAppAuthDir();
    const credsPath = path.join(dir, WHATSAPP_CREDS_FILE);
    const backupPath = path.join(dir, WHATSAPP_CREDS_BACKUP_FILE);

    try {
      if (!fs.existsSync(credsPath)) return;
      const raw = fs.readFileSync(credsPath, 'utf-8');
      JSON.parse(raw); // Only backup valid JSON
      fs.copyFileSync(credsPath, backupPath);
    } catch {
      // Ignore backup failures
    }
  }

  /**
   * Clear all WhatsApp credentials (logout). Idempotent.
   */
  static clearCredentials(): void {
    const dir = getWhatsAppAuthDir();
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      console.log('[WhatsAppAuth] Credentials cleared');
    } catch (error) {
      console.error('[WhatsAppAuth] Failed to clear credentials:', error);
    }
  }

  /**
   * Get the linked phone number (E.164) from stored credentials, if any.
   */
  static getLinkedPhoneNumber(): string | null {
    const credsPath = path.join(getWhatsAppAuthDir(), WHATSAPP_CREDS_FILE);
    try {
      if (!fs.existsSync(credsPath)) return null;
      const raw = fs.readFileSync(credsPath, 'utf-8');
      const creds = JSON.parse(raw) as WhatsAppCredsFile;
      return jidToPhone(creds.me?.id);
    } catch {
      return null;
    }
  }
}
