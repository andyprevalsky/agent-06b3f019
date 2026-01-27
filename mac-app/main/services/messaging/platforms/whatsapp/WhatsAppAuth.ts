import { app } from 'electron';
import fs from 'fs';
import path from 'path';

const WHATSAPP_AUTH_DIR = path.join(app.getPath('userData'), 'whatsapp-auth');
const CREDS_FILE = 'creds.json';
const CREDS_BACKUP_FILE = 'creds.json.bak';

/**
 * WhatsApp authentication state management.
 * Uses Baileys' multi-file auth state with backup/restore capability.
 */
export class WhatsAppAuth {
  /**
   * Get the auth directory path.
   */
  static getAuthDir(): string {
    return WHATSAPP_AUTH_DIR;
  }

  /**
   * Ensure auth directory exists.
   */
  static ensureAuthDir(): void {
    if (!fs.existsSync(WHATSAPP_AUTH_DIR)) {
      fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
    }
  }

  /**
   * Check if credentials exist and are valid.
   */
  static hasCredentials(): boolean {
    const credsPath = path.join(WHATSAPP_AUTH_DIR, CREDS_FILE);
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
   */
  static maybeRestoreFromBackup(): boolean {
    const credsPath = path.join(WHATSAPP_AUTH_DIR, CREDS_FILE);
    const backupPath = path.join(WHATSAPP_AUTH_DIR, CREDS_BACKUP_FILE);

    try {
      // Check if main creds are valid
      if (fs.existsSync(credsPath)) {
        const raw = fs.readFileSync(credsPath, 'utf-8');
        JSON.parse(raw);
        return false; // Creds are valid, no restore needed
      }
    } catch {
      // Main creds are corrupted or missing
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
   * Create a backup of current credentials.
   */
  static backupCredentials(): void {
    const credsPath = path.join(WHATSAPP_AUTH_DIR, CREDS_FILE);
    const backupPath = path.join(WHATSAPP_AUTH_DIR, CREDS_BACKUP_FILE);

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
   * Clear all WhatsApp credentials (logout).
   */
  static clearCredentials(): void {
    try {
      if (fs.existsSync(WHATSAPP_AUTH_DIR)) {
        fs.rmSync(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
      }
      console.log('[WhatsAppAuth] Credentials cleared');
    } catch (error) {
      console.error('[WhatsAppAuth] Failed to clear credentials:', error);
    }
  }

  /**
   * Get the linked phone number (JID) from stored credentials.
   */
  static getLinkedPhoneNumber(): string | null {
    const credsPath = path.join(WHATSAPP_AUTH_DIR, CREDS_FILE);
    try {
      if (!fs.existsSync(credsPath)) return null;
      const raw = fs.readFileSync(credsPath, 'utf-8');
      const creds = JSON.parse(raw) as { me?: { id?: string } };
      const jid = creds?.me?.id;
      if (!jid) return null;
      // Extract phone number from JID (format: 1234567890:12@s.whatsapp.net)
      const match = jid.match(/^(\d+)/);
      return match ? `+${match[1]}` : null;
    } catch {
      return null;
    }
  }
}
