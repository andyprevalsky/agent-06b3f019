/**
 * messaging-whatsapp: repo layer
 *
 * Filesystem-backed persistence for Baileys' multi-file auth state, plus helpers
 * that parse the credentials file for the linked phone number. No business logic;
 * just typed data access against `fs` and `path`.
 *
 * One WhatsApp account = one auth dir (plan row I2):
 *
 *   userData/whatsapp-auth/             legacy single-account dir (never moved)
 *   userData/whatsapp-accounts/<slot>/  every account paired since
 *
 * A slot is named when pairing starts, before the phone number is known; the
 * account id is always read back from that dir's `creds.json` (`me.id`).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  WHATSAPP_ACCOUNT_SLOT_PREFIX,
  WHATSAPP_CREDS_BACKUP_FILE,
  WHATSAPP_CREDS_FILE,
  getWhatsAppAccountsRoot,
  getWhatsAppAuthDir,
} from './config';
import { jidToPhone } from './normalize';
import type { WhatsAppCredsFile } from './types';

/** Baileys multi-file auth state of ONE account, with backup/restore capability. */
export class WhatsAppAuthStore {
  constructor(readonly dir: string) {}

  private get credsPath(): string {
    return path.join(this.dir, WHATSAPP_CREDS_FILE);
  }

  private get backupPath(): string {
    return path.join(this.dir, WHATSAPP_CREDS_BACKUP_FILE);
  }

  /** Ensure the auth directory exists. Idempotent. */
  ensureAuthDir(): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  /** Credentials exist and are valid JSON with non-trivial content. */
  hasCredentials(): boolean {
    try {
      if (!fs.existsSync(this.credsPath)) return false;
      const stats = fs.statSync(this.credsPath);
      if (!stats.isFile() || stats.size <= 1) return false;
      JSON.parse(fs.readFileSync(this.credsPath, 'utf-8'));
      return true;
    } catch {
      return false;
    }
  }

  /** Restore credentials from backup when the main creds are corrupted. True only on restore. */
  maybeRestoreFromBackup(): boolean {
    try {
      if (fs.existsSync(this.credsPath)) {
        JSON.parse(fs.readFileSync(this.credsPath, 'utf-8'));
        return false; // Creds are valid, no restore needed
      }
    } catch {
      // Main creds are corrupted or missing — fall through to restore
    }
    try {
      if (!fs.existsSync(this.backupPath)) return false;
      JSON.parse(fs.readFileSync(this.backupPath, 'utf-8'));
      fs.copyFileSync(this.backupPath, this.credsPath);
      console.log('[WhatsAppAuth] Restored credentials from backup');
      return true;
    } catch {
      return false;
    }
  }

  /** Back up the current credentials. No-op on missing/invalid creds. */
  backupCredentials(): void {
    try {
      if (!fs.existsSync(this.credsPath)) return;
      JSON.parse(fs.readFileSync(this.credsPath, 'utf-8')); // Only backup valid JSON
      fs.copyFileSync(this.credsPath, this.backupPath);
    } catch {
      // Ignore backup failures
    }
  }

  /** Remove this account's auth dir (logout). Idempotent. */
  clearCredentials(): void {
    try {
      if (fs.existsSync(this.dir)) fs.rmSync(this.dir, { recursive: true, force: true });
      console.log('[WhatsAppAuth] Credentials cleared');
    } catch (error) {
      console.error('[WhatsAppAuth] Failed to clear credentials:', error);
    }
  }

  /** The linked phone number (E.164) from this dir's credentials, if any. */
  getLinkedPhoneNumber(): string | null {
    try {
      if (!fs.existsSync(this.credsPath)) return null;
      const creds = JSON.parse(fs.readFileSync(this.credsPath, 'utf-8')) as WhatsAppCredsFile;
      return jidToPhone(creds.me?.id);
    } catch {
      return null;
    }
  }
}

/** The legacy single-account store (`userData/whatsapp-auth`). */
export function legacyWhatsAppAuthStore(): WhatsAppAuthStore {
  return new WhatsAppAuthStore(getWhatsAppAuthDir());
}

/** Every store holding credentials: the legacy dir first, then slots in pairing order. */
export function listWhatsAppAuthStores(): WhatsAppAuthStore[] {
  const stores = [legacyWhatsAppAuthStore()];
  const root = getWhatsAppAccountsRoot();
  try {
    const slots = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const slot of slots) stores.push(new WhatsAppAuthStore(path.join(root, slot)));
  } catch {
    // No multi-account root yet.
  }
  return stores.filter((store) => store.hasCredentials());
}

/** A fresh, empty slot for pairing one more account. */
export function createWhatsAppAuthStore(): WhatsAppAuthStore {
  const slot = `${WHATSAPP_ACCOUNT_SLOT_PREFIX}${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return new WhatsAppAuthStore(path.join(getWhatsAppAccountsRoot(), slot));
}

/**
 * Static facade over the legacy single-account store, kept for callers and
 * tests written before multi-account.
 */
export class WhatsAppAuth {
  static getAuthDir(): string {
    return getWhatsAppAuthDir();
  }

  static ensureAuthDir(): void {
    legacyWhatsAppAuthStore().ensureAuthDir();
  }

  static hasCredentials(): boolean {
    return legacyWhatsAppAuthStore().hasCredentials();
  }

  static maybeRestoreFromBackup(): boolean {
    return legacyWhatsAppAuthStore().maybeRestoreFromBackup();
  }

  static backupCredentials(): void {
    legacyWhatsAppAuthStore().backupCredentials();
  }

  static clearCredentials(): void {
    legacyWhatsAppAuthStore().clearCredentials();
  }

  static getLinkedPhoneNumber(): string | null {
    return legacyWhatsAppAuthStore().getLinkedPhoneNumber();
  }
}
