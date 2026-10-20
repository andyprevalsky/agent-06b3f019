/**
 * messaging-telegram repo layer.
 *
 * Disk-backed StringSession persistence. Sole consumer of the userData
 * filesystem for Telegram authentication state.
 *
 *   telegram-auth/
 *     session.txt                      legacy single-account login (migrated on connect)
 *     accounts/<telegram user id>/
 *       session.txt                    that account's StringSession
 *       account.json                   { label, claimLegacy? }
 *
 * Imports: own config, own types, `fs`, `path`, GramJS `StringSession` type.
 */
import fs from 'fs';
import path from 'path';
import { StringSession } from 'telegram/sessions';
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNTS_DIR,
  PROFILE_FILE,
  SESSION_FILE,
  TELEGRAM_AUTH_DIR,
} from './config';
import type { TelegramAccountProfile } from './types';

function readNonEmpty(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

function writePrivate(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Telegram authentication state management.
 * Uses GramJS StringSession for persistent login.
 */
export class TelegramAuth {
  /**
   * Get the auth directory path.
   */
  static getAuthDir(): string {
    return TELEGRAM_AUTH_DIR;
  }

  /**
   * Ensure auth directory exists.
   */
  static ensureAuthDir(): void {
    if (!fs.existsSync(TELEGRAM_AUTH_DIR)) {
      fs.mkdirSync(TELEGRAM_AUTH_DIR, { recursive: true });
    }
  }

  /**
   * Load the legacy single-account session string.
   */
  static loadSession(): StringSession {
    this.ensureAuthDir();
    const sessionString = readNonEmpty(path.join(TELEGRAM_AUTH_DIR, SESSION_FILE));
    if (sessionString !== null) {
      console.log('[TelegramAuth] Loaded existing session');
      return new StringSession(sessionString);
    }
    return new StringSession('');
  }

  /**
   * Save the legacy single-account session string to disk.
   */
  static saveSession(session: StringSession): void {
    this.ensureAuthDir();
    const sessionPath = path.join(TELEGRAM_AUTH_DIR, SESSION_FILE);

    try {
      const sessionString = session.save();
      fs.writeFileSync(sessionPath, sessionString, 'utf-8');
      console.log('[TelegramAuth] Session saved');
    } catch (error) {
      console.error('[TelegramAuth] Failed to save session:', error);
    }
  }

  /** True when the legacy single-account session file holds a session. */
  static hasLegacySession(): boolean {
    return readNonEmpty(path.join(TELEGRAM_AUTH_DIR, SESSION_FILE)) !== null;
  }

  /**
   * Check if any session exists (legacy or per-account).
   */
  static hasSession(): boolean {
    return this.hasLegacySession() || this.listAccountIds().length > 0;
  }

  /**
   * Clear every session (log out all accounts locally).
   */
  static clearSession(): void {
    try {
      if (fs.existsSync(TELEGRAM_AUTH_DIR)) {
        fs.rmSync(TELEGRAM_AUTH_DIR, { recursive: true, force: true });
      }
      console.log('[TelegramAuth] Session cleared');
    } catch (error) {
      console.error('[TelegramAuth] Failed to clear session:', error);
    }
  }

  /** Remove only the legacy single-account session file. */
  static clearLegacySession(): void {
    fs.rmSync(path.join(TELEGRAM_AUTH_DIR, SESSION_FILE), { force: true });
  }

  /** The account's directory. Throws for anything but a numeric Telegram user id. */
  static accountDir(accountId: string): string {
    if (!ACCOUNT_ID_PATTERN.test(accountId)) {
      throw new Error(`Invalid Telegram account id: ${accountId}`);
    }
    return path.join(ACCOUNTS_DIR, accountId);
  }

  /** Account ids (Telegram user ids) that have a saved session, ascending. */
  static listAccountIds(): string[] {
    if (!fs.existsSync(ACCOUNTS_DIR)) return [];
    return fs
      .readdirSync(ACCOUNTS_DIR)
      .filter((id) => ACCOUNT_ID_PATTERN.test(id))
      .filter((id) => readNonEmpty(path.join(ACCOUNTS_DIR, id, SESSION_FILE)) !== null)
      .sort((a, b) => a.length - b.length || a.localeCompare(b));
  }

  static loadAccountSession(accountId: string): StringSession {
    const value = readNonEmpty(path.join(this.accountDir(accountId), SESSION_FILE));
    return new StringSession(value ?? '');
  }

  static saveAccountSession(
    accountId: string,
    session: StringSession,
    profile: TelegramAccountProfile
  ): void {
    const dir = this.accountDir(accountId);
    writePrivate(path.join(dir, SESSION_FILE), session.save());
    this.writeAccountProfile(accountId, profile);
  }

  static readAccountProfile(accountId: string): TelegramAccountProfile {
    const raw = readNonEmpty(path.join(this.accountDir(accountId), PROFILE_FILE));
    if (raw === null) return { label: null };
    try {
      const parsed = JSON.parse(raw) as Partial<TelegramAccountProfile>;
      return {
        label: typeof parsed.label === 'string' ? parsed.label : null,
        ...(parsed.claimLegacy === true && { claimLegacy: true }),
      };
    } catch {
      return { label: null };
    }
  }

  static writeAccountProfile(accountId: string, profile: TelegramAccountProfile): void {
    writePrivate(path.join(this.accountDir(accountId), PROFILE_FILE), JSON.stringify(profile));
  }

  /** Remove one account's session and profile; other accounts are untouched. */
  static clearAccountSession(accountId: string): void {
    fs.rmSync(this.accountDir(accountId), { recursive: true, force: true });
  }

  /**
   * Move the legacy single-account session into its account directory, marked
   * so the next registration claims the backend's legacy Telegram row.
   */
  static adoptLegacySession(accountId: string, label: string | null): void {
    const legacy = readNonEmpty(path.join(TELEGRAM_AUTH_DIR, SESSION_FILE));
    if (legacy === null) return;
    this.saveAccountSession(accountId, new StringSession(legacy), { label, claimLegacy: true });
    this.clearLegacySession();
  }
}
