import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { StringSession } from 'telegram/sessions';

const TELEGRAM_AUTH_DIR = path.join(app.getPath('userData'), 'telegram-auth');
const SESSION_FILE = 'session.txt';

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
   * Load existing session string.
   */
  static loadSession(): StringSession {
    this.ensureAuthDir();
    const sessionPath = path.join(TELEGRAM_AUTH_DIR, SESSION_FILE);

    try {
      if (fs.existsSync(sessionPath)) {
        const sessionString = fs.readFileSync(sessionPath, 'utf-8').trim();
        if (sessionString) {
          console.log('[TelegramAuth] Loaded existing session');
          return new StringSession(sessionString);
        }
      }
    } catch (error) {
      console.warn('[TelegramAuth] Failed to load session:', error);
    }

    return new StringSession('');
  }

  /**
   * Save session string to disk.
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

  /**
   * Check if session exists.
   */
  static hasSession(): boolean {
    const sessionPath = path.join(TELEGRAM_AUTH_DIR, SESSION_FILE);
    try {
      if (!fs.existsSync(sessionPath)) return false;
      const content = fs.readFileSync(sessionPath, 'utf-8').trim();
      return content.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Clear session (logout).
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
}
