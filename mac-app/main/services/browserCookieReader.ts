import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { glob } from 'glob';
import type { CookieData } from '../../shared/types/ipc';

const execAsync = promisify(exec);

export type BrowserType =
  | 'chrome'
  | 'edge'
  | 'brave'
  | 'arc'
  | 'opera'
  | 'vivaldi'
  | 'chromium'
  | 'atlas';

export interface BrowserConfig {
  type: BrowserType;
  name: string;
  cookiePathPattern: string;
  keychainEntry: string;
  keychainAccount: string;
  needsManualPassword: boolean;
}

export interface BrowserInfo extends BrowserConfig {
  isInstalled: boolean;
  resolvedCookiePath?: string;
}

export interface ReadCookiesConfig {
  keychainPassword?: string;
}

const HOME = app.getPath('home');

const BROWSERS: Record<BrowserType, BrowserConfig> = {
  chrome: {
    type: 'chrome',
    name: 'Chrome',
    cookiePathPattern: path.join(HOME, 'Library/Application Support/Google/Chrome/Default/Cookies'),
    keychainEntry: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    needsManualPassword: false,
  },
  edge: {
    type: 'edge',
    name: 'Microsoft Edge',
    cookiePathPattern: path.join(HOME, 'Library/Application Support/Microsoft Edge/Default/Cookies'),
    keychainEntry: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
    needsManualPassword: false,
  },
  brave: {
    type: 'brave',
    name: 'Brave',
    cookiePathPattern: path.join(HOME, 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies'),
    keychainEntry: 'Brave Safe Storage',
    keychainAccount: 'Brave',
    needsManualPassword: false,
  },
  arc: {
    type: 'arc',
    name: 'Arc',
    cookiePathPattern: path.join(HOME, 'Library/Application Support/Arc/User Data/Default/Cookies'),
    keychainEntry: 'Arc Safe Storage',
    keychainAccount: 'Arc',
    needsManualPassword: false,
  },
  opera: {
    type: 'opera',
    name: 'Opera',
    cookiePathPattern: path.join(HOME, 'Library/Application Support/com.operasoftware.Opera/Cookies'),
    keychainEntry: 'Opera Safe Storage',
    keychainAccount: 'Opera',
    needsManualPassword: false,
  },
  vivaldi: {
    type: 'vivaldi',
    name: 'Vivaldi',
    cookiePathPattern: path.join(HOME, 'Library/Application Support/Vivaldi/Default/Cookies'),
    keychainEntry: 'Vivaldi Safe Storage',
    keychainAccount: 'Vivaldi',
    needsManualPassword: false,
  },
  chromium: {
    type: 'chromium',
    name: 'Chromium',
    cookiePathPattern: path.join(HOME, 'Library/Application Support/Chromium/Default/Cookies'),
    keychainEntry: 'Chromium Safe Storage',
    keychainAccount: 'Chromium',
    needsManualPassword: false,
  },
  atlas: {
    type: 'atlas',
    name: 'ChatGPT Atlas',
    cookiePathPattern: path.join(HOME, 'Library/Application Support/com.openai.atlas/browser-data/host/user-*/Cookies'),
    keychainEntry: 'ChatGPT Safe Storage',
    keychainAccount: 'ChatGPT',
    needsManualPassword: true,
  },
};

/**
 * BrowserCookieReader provides multi-browser cookie reading support.
 *
 * Supported Chromium-based browsers (automatic keychain access):
 * - Chrome, Edge, Brave, Arc, Opera, Vivaldi, Chromium
 *
 * Browsers requiring manual keychain password:
 * - Atlas (ChatGPT Desktop): Uses Data Protection keychain
 */
export class BrowserCookieReader {
  private static readonly CHROME_PREFIX_LENGTH = 32;

  /**
   * Resolve a cookie path pattern that may contain wildcards.
   * Returns the first matching path or null if not found.
   */
  private static resolveCookiePath(pattern: string): string | null {
    // If no wildcards, check directly
    if (!pattern.includes('*')) {
      return fs.existsSync(pattern) ? pattern : null;
    }

    // Use glob to find matching paths
    const matches = glob.sync(pattern);
    if (matches.length === 0) {
      return null;
    }

    // Return the most recently modified match
    const sorted = matches
      .map(p => ({ path: p, mtime: fs.statSync(p).mtime.getTime() }))
      .sort((a, b) => b.mtime - a.mtime);

    return sorted[0].path;
  }

  /**
   * Get list of installed browsers with their configurations.
   */
  static getInstalledBrowsers(): BrowserInfo[] {
    const results = Object.values(BROWSERS).map(browser => {
      const resolvedPath = this.resolveCookiePath(browser.cookiePathPattern);
      console.log(`[BrowserCookieReader] Checking ${browser.name}: pattern=${browser.cookiePathPattern}, resolved=${resolvedPath}`);
      return {
        ...browser,
        isInstalled: resolvedPath !== null,
        resolvedCookiePath: resolvedPath ?? undefined,
      };
    });
    const installed = results.filter(b => b.isInstalled);
    console.log(`[BrowserCookieReader] Found ${installed.length} installed browsers:`, installed.map(b => b.type));
    return installed;
  }

  /**
   * Get browser configuration by type.
   */
  static getBrowserConfig(browserType: BrowserType): BrowserConfig | null {
    return BROWSERS[browserType] ?? null;
  }

  /**
   * Get encryption key for a browser.
   * For Chrome: retrieves from keychain via CLI
   * For Atlas: requires manual password parameter
   */
  private static async getEncryptionKey(
    browser: BrowserConfig,
    config?: ReadCookiesConfig
  ): Promise<Buffer> {
    let password: string;

    if (browser.needsManualPassword) {
      // Atlas and other Data Protection keychain browsers
      if (!config?.keychainPassword) {
        throw new Error(
          `${browser.name} requires a keychain password. ` +
          `Please provide the password from "${browser.keychainEntry}" in Keychain Access.`
        );
      }
      password = config.keychainPassword;
    } else {
      // Chrome and other file-based keychain browsers
      try {
        const { stdout } = await execAsync(
          `security find-generic-password -wa "${browser.keychainAccount}"`
        );
        password = stdout.trim();
      } catch (error) {
        throw new Error(
          `Failed to get ${browser.name} encryption key from keychain. ` +
          `Make sure ${browser.name} is installed and has been run at least once.`
        );
      }
    }

    // Derive AES key using PBKDF2-SHA1
    // All Chromium browsers use: salt="saltysalt", iterations=1003, key_length=16
    const salt = 'saltysalt';
    const iterations = 1003;
    return crypto.pbkdf2Sync(password, salt, iterations, 16, 'sha1');
  }

  /**
   * Remove PKCS7 padding from decrypted data.
   */
  private static removePKCS7Padding(data: Buffer): Buffer {
    if (data.length === 0) return data;
    const paddingLength = data[data.length - 1];
    if (paddingLength > 16 || paddingLength > data.length) {
      return data;
    }
    for (let i = data.length - paddingLength; i < data.length; i++) {
      if (data[i] !== paddingLength) {
        return data;
      }
    }
    return data.slice(0, data.length - paddingLength);
  }

  /**
   * Check if a string contains only valid cookie value characters.
   * Cookie values should be printable ASCII (or valid UTF-8 for some cookies).
   */
  private static isValidCookieValue(value: string): boolean {
    if (!value) return false;
    // Check for null bytes or other control characters (except common whitespace)
    // Valid cookie values are typically printable ASCII or valid UTF-8
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      // Allow printable ASCII (32-126), tab (9), and valid UTF-8 continuation
      if (code < 32 && code !== 9) return false;
      if (code === 127) return false; // DEL character
      // Check for replacement character (indicates invalid UTF-8 decoding)
      if (code === 0xFFFD) return false;
    }
    return true;
  }

  /**
   * Decrypt a cookie value using Chromium's v10 encryption.
   * All Chromium-based browsers use the same encryption format.
   */
  private static decryptValue(encryptedValue: Buffer, key: Buffer): string | null {
    if (!encryptedValue || encryptedValue.length === 0) {
      return null;
    }

    const prefix = encryptedValue.slice(0, 3).toString();
    if (prefix !== 'v10') {
      // Try plaintext
      const asString = encryptedValue.toString('utf8');
      if (asString && /^[\x20-\x7E]*$/.test(asString)) {
        return asString;
      }
      return null;
    }

    if (encryptedValue.length < 4) {
      return null;
    }

    try {
      const iv = Buffer.alloc(16, ' ');
      const ciphertext = encryptedValue.slice(3);

      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(false);

      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);

      const unpadded = this.removePKCS7Padding(decrypted);

      if (unpadded.length > this.CHROME_PREFIX_LENGTH) {
        const value = unpadded.slice(this.CHROME_PREFIX_LENGTH).toString('utf8');
        // Validate the decrypted value looks like a real cookie value
        if (this.isValidCookieValue(value)) {
          return value;
        }
        return null;
      }

      return '';
    } catch {
      return null;
    }
  }

  /**
   * Read cookies from a specific browser.
   *
   * @param browserType - The browser to read from ('chrome' | 'atlas')
   * @param config - Optional configuration (keychainPassword required for Atlas)
   */
  static async readCookies(
    browserType: BrowserType,
    config?: ReadCookiesConfig
  ): Promise<CookieData[]> {
    const browser = BROWSERS[browserType];
    if (!browser) {
      throw new Error(`Unknown browser type: ${browserType}`);
    }

    const cookiePath = this.resolveCookiePath(browser.cookiePathPattern);
    if (!cookiePath) {
      console.log(`[BrowserCookieReader] ${browser.name} cookies file not found`);
      return [];
    }

    // Copy database (browser locks it)
    const tempPath = path.join(app.getPath('temp'), `Cookies-${browserType}-copy`);
    fs.copyFileSync(cookiePath, tempPath);

    const db = new Database(tempPath, { readonly: true });

    try {
      const key = await this.getEncryptionKey(browser, config);

      const rows = db.prepare(`
        SELECT
          host_key,
          name,
          encrypted_value,
          path,
          expires_utc,
          is_secure,
          is_httponly,
          creation_utc,
          top_frame_site_key,
          last_access_utc,
          has_expires,
          is_persistent,
          priority,
          samesite,
          source_scheme,
          source_port,
          last_update_utc
        FROM cookies
      `).all() as any[];

      const cookies: CookieData[] = [];
      let skipped = 0;

      for (const row of rows) {
        const value = this.decryptValue(row.encrypted_value, key);

        if (value === null || value === '') {
          skipped++;
          continue;
        }

        cookies.push({
          host_key: row.host_key,
          name: row.name,
          value,
          path: row.path,
          expires_utc: row.expires_utc,
          is_secure: row.is_secure === 1,
          is_httponly: row.is_httponly === 1,
          creation_utc: row.creation_utc,
          top_frame_site_key: row.top_frame_site_key ?? '',
          last_access_utc: row.last_access_utc,
          has_expires: row.has_expires === 1,
          is_persistent: row.is_persistent === 1,
          priority: row.priority,
          samesite: row.samesite,
          source_scheme: row.source_scheme,
          source_port: row.source_port,
          last_update_utc: row.last_update_utc,
        });
      }

      // Validate that we successfully decrypted a reasonable number of cookies.
      // If nearly all cookies failed to decrypt, the password is likely wrong.
      const totalCookies = rows.length;
      const successRate = totalCookies > 0 ? cookies.length / totalCookies : 0;

      if (totalCookies > 10 && successRate < 0.1) {
        // Less than 10% success rate with a significant number of cookies
        // indicates the decryption key (password) is incorrect
        throw new Error(
          `Failed to decrypt ${browser.name} cookies. ` +
          `The keychain password may be incorrect. ` +
          `(${cookies.length}/${totalCookies} cookies decrypted successfully)`
        );
      }

      console.log(
        `[BrowserCookieReader] Read ${cookies.length} ${browser.name} cookies ` +
        `(skipped ${skipped} unreadable)`
      );
      return cookies;
    } finally {
      db.close();
      fs.unlinkSync(tempPath);
    }
  }
}
