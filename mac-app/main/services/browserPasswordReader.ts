import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { glob } from 'glob';

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
// Note: Atlas requires manual keychain password entry (uses "ChatGPT Safe Storage")

export interface BrowserConfig {
  type: BrowserType;
  name: string;
  loginDataPathPattern: string;
  keychainEntry: string;
  keychainAccount: string;
}

export interface BrowserInfo extends BrowserConfig {
  isInstalled: boolean;
  resolvedLoginDataPath?: string;
}

export interface ReadPasswordsConfig {
  keychainPassword?: string;
}

/**
 * Password entry data structure
 */
export interface PasswordData {
  origin: string;           // e.g., "https://amazon.com"
  username: string;         // e.g., "user@email.com"
  password: string;         // Decrypted plaintext password
  dateLastUsed: number;     // Chromium timestamp (microseconds since 1601)
  dateCreated: number;      // Chromium timestamp
  browserSource: string;    // Which browser this came from
}

/**
 * Encrypted password envelope for storage
 * Uses same RSA-2048 + AES-256-GCM pattern as payment encryption
 */
export interface EncryptedPasswordEnvelope {
  version: 1;
  encrypted_aes_key: string;  // Base64-encoded RSA-encrypted AES key
  iv: string;                  // Base64-encoded AES-GCM IV
  ciphertext: string;          // Base64-encoded AES-encrypted password
}

const HOME = app.getPath('home');

const BROWSERS: Record<BrowserType, BrowserConfig> = {
  chrome: {
    type: 'chrome',
    name: 'Chrome',
    loginDataPathPattern: path.join(HOME, 'Library/Application Support/Google/Chrome/Default/Login Data'),
    keychainEntry: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
  },
  edge: {
    type: 'edge',
    name: 'Microsoft Edge',
    loginDataPathPattern: path.join(HOME, 'Library/Application Support/Microsoft Edge/Default/Login Data'),
    keychainEntry: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
  },
  brave: {
    type: 'brave',
    name: 'Brave',
    loginDataPathPattern: path.join(HOME, 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Login Data'),
    keychainEntry: 'Brave Safe Storage',
    keychainAccount: 'Brave',
  },
  arc: {
    type: 'arc',
    name: 'Arc',
    loginDataPathPattern: path.join(HOME, 'Library/Application Support/Arc/User Data/Default/Login Data'),
    keychainEntry: 'Arc Safe Storage',
    keychainAccount: 'Arc',
  },
  opera: {
    type: 'opera',
    name: 'Opera',
    loginDataPathPattern: path.join(HOME, 'Library/Application Support/com.operasoftware.Opera/Login Data'),
    keychainEntry: 'Opera Safe Storage',
    keychainAccount: 'Opera',
  },
  vivaldi: {
    type: 'vivaldi',
    name: 'Vivaldi',
    loginDataPathPattern: path.join(HOME, 'Library/Application Support/Vivaldi/Default/Login Data'),
    keychainEntry: 'Vivaldi Safe Storage',
    keychainAccount: 'Vivaldi',
  },
  chromium: {
    type: 'chromium',
    name: 'Chromium',
    loginDataPathPattern: path.join(HOME, 'Library/Application Support/Chromium/Default/Login Data'),
    keychainEntry: 'Chromium Safe Storage',
    keychainAccount: 'Chromium',
  },
  atlas: {
    type: 'atlas',
    name: 'ChatGPT Atlas',
    // Atlas stores passwords in browser-data/host/user-*/Login Data (wildcard for user profile)
    loginDataPathPattern: path.join(HOME, 'Library/Application Support/com.openai.atlas/browser-data/host/user-*/Login Data'),
    keychainEntry: 'ChatGPT Safe Storage',
    keychainAccount: 'ChatGPT',
  },
};

// RSA-2048 Public Key - same as payment encryption
// The corresponding private key is stored as PAYMENT_DECRYPTION_KEY on agent workers
const RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjSyJhixvre5abdAOA8QK
MZN9ftryV1ST5bQ/Ne2SsA0LUlsy/t0gVickAHf/iMAI473qBGrJIgYgEBrnQ9Vy
ak1DpYWG9rC8KNZs/AQnWHiDWKGNUwWTAbT0fZeDHbckgJXiAok2U23F7tHtA1v6
V65dHj1C+wlb8bBkJtDgSxKIcG6GMZFfR5Arzq8ILQ20mtAP2HW80SeWGiw6Ecnd
a0RL0kn3Mqzjuw8NB4Iqx7UThKuIZdEnUhdnlVcXhfpEJUngcOm6pqQGNQok+VtL
MHxsrQsQo0UMgE8zQamTXpTGJEB1G22gPaEY5FB2V8dgWs6PxBTaYZMOH9TRy2G4
EwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * BrowserPasswordReader provides multi-browser password reading support.
 *
 * Reads saved passwords from Chromium-based browsers, decrypts them locally,
 * then re-encrypts with RSA-2048 + AES-256-GCM for secure storage.
 *
 * Supported browsers: Chrome, Edge, Brave, Arc, Opera, Vivaldi, Chromium
 */
export class BrowserPasswordReader {
  /**
   * Resolve a login data path pattern that may contain wildcards.
   * Returns the first matching path or null if not found.
   */
  private static resolveLoginDataPath(pattern: string): string | null {
    if (!pattern.includes('*')) {
      return fs.existsSync(pattern) ? pattern : null;
    }

    const matches = glob.sync(pattern);
    if (matches.length === 0) {
      return null;
    }

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
      const resolvedPath = this.resolveLoginDataPath(browser.loginDataPathPattern);
      console.log(`[BrowserPasswordReader] Checking ${browser.name}: pattern=${browser.loginDataPathPattern}, resolved=${resolvedPath}`);
      return {
        ...browser,
        isInstalled: resolvedPath !== null,
        resolvedLoginDataPath: resolvedPath ?? undefined,
      };
    });
    const installed = results.filter(b => b.isInstalled);
    console.log(`[BrowserPasswordReader] Found ${installed.length} installed browsers with Login Data:`, installed.map(b => b.type));
    return installed;
  }

  /**
   * Get browser configuration by type.
   */
  static getBrowserConfig(browserType: BrowserType): BrowserConfig | null {
    return BROWSERS[browserType] ?? null;
  }

  /**
   * Get encryption key for a browser from macOS keychain.
   * @param browser - Browser configuration
   * @param manualPassword - Optional manual password (for browsers like Atlas that require it)
   */
  private static async getEncryptionKey(browser: BrowserConfig, manualPassword?: string): Promise<Buffer> {
    let password: string;

    console.log(`[BrowserPasswordReader] getEncryptionKey called for ${browser.name}, manualPassword provided: ${!!manualPassword}`);

    if (manualPassword) {
      // Use the manually provided keychain password
      console.log(`[BrowserPasswordReader] Using manual password (length: ${manualPassword.length})`);
      password = manualPassword;
    } else {
      // Try to get the password from the keychain automatically
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
   * Decrypt a password value using Chromium's v10 encryption.
   * Password values don't have the 32-byte prefix that cookies have.
   */
  private static decryptPassword(encryptedValue: Buffer, key: Buffer): string | null {
    if (!encryptedValue || encryptedValue.length === 0) {
      return null;
    }

    const prefix = encryptedValue.slice(0, 3).toString();
    if (prefix !== 'v10') {
      // Try plaintext (older format)
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

      // Password values are stored directly (no 32-byte prefix like cookies)
      const password = unpadded.toString('utf8');

      // Validate that decrypted password contains only printable characters
      // Wrong decryption key produces garbage bytes that fail this check
      // Allows printable ASCII (0x20-0x7E) plus common extended chars (accented letters, etc.)
      if (!/^[\x20-\x7E\u00A0-\u00FF\u0100-\u017F]*$/.test(password)) {
        return null;
      }

      return password;
    } catch {
      return null;
    }
  }

  /**
   * Encrypt a password using RSA-2048 + AES-256-GCM hybrid encryption.
   * Returns base64-encoded envelope.
   */
  static async encryptPassword(password: string): Promise<string> {
    // 1. Parse RSA public key
    const pemContents = RSA_PUBLIC_KEY_PEM
      .replace('-----BEGIN PUBLIC KEY-----', '')
      .replace('-----END PUBLIC KEY-----', '')
      .replace(/\s/g, '');
    const publicKeyDer = Buffer.from(pemContents, 'base64');

    // 2. Generate random AES-256 key and IV
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    // 3. Encrypt password with AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(password, 'utf8'),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();
    const ciphertext = Buffer.concat([encrypted, authTag]);

    // 4. Encrypt AES key with RSA-OAEP
    const encryptedAesKey = crypto.publicEncrypt(
      {
        key: RSA_PUBLIC_KEY_PEM,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      aesKey
    );

    // 5. Build envelope
    const envelope: EncryptedPasswordEnvelope = {
      version: 1,
      encrypted_aes_key: encryptedAesKey.toString('base64'),
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };

    return Buffer.from(JSON.stringify(envelope)).toString('base64');
  }

  /**
   * Read passwords from a specific browser.
   *
   * @param browserType - The browser to read from
   * @returns Array of password data with decrypted passwords
   */
  static async readPasswords(
    browserType: BrowserType,
    config?: ReadPasswordsConfig
  ): Promise<PasswordData[]> {
    const browser = BROWSERS[browserType];
    if (!browser) {
      throw new Error(`Unknown browser type: ${browserType}`);
    }

    const loginDataPath = this.resolveLoginDataPath(browser.loginDataPathPattern);
    if (!loginDataPath) {
      console.log(`[BrowserPasswordReader] ${browser.name} Login Data file not found`);
      return [];
    }

    // Copy database (browser locks it)
    const tempPath = path.join(app.getPath('temp'), `LoginData-${browserType}-copy`);
    fs.copyFileSync(loginDataPath, tempPath);

    const db = new Database(tempPath, { readonly: true });

    try {
      const key = await this.getEncryptionKey(browser, config?.keychainPassword);

      const rows = db.prepare(`
        SELECT
          origin_url,
          username_value,
          password_value,
          date_last_used,
          date_created
        FROM logins
        WHERE blacklisted_by_user = 0
        ORDER BY date_last_used DESC
      `).all() as any[];

      const passwords: PasswordData[] = [];
      let emptyEntries = 0;
      let decryptionFailures = 0;

      for (const row of rows) {
        // Skip entries without username or password
        if (!row.username_value || !row.password_value || row.password_value.length === 0) {
          emptyEntries++;
          continue;
        }

        const password = this.decryptPassword(row.password_value, key);

        if (password === null || password === '') {
          decryptionFailures++;
          continue;
        }

        passwords.push({
          origin: row.origin_url,
          username: row.username_value,
          password,
          dateLastUsed: row.date_last_used || 0,
          dateCreated: row.date_created || 0,
          browserSource: browserType,
        });
      }

      console.log(
        `[BrowserPasswordReader] Read ${passwords.length} ${browser.name} passwords ` +
        `(empty: ${emptyEntries}, decryption failures: ${decryptionFailures})`
      );

      // If we had encrypted entries but ALL decryption failed, likely wrong keychain password
      if (passwords.length === 0 && decryptionFailures > 0 && config?.keychainPassword) {
        throw new Error('Failed to decrypt passwords. Please check that you entered the correct keychain password.');
      }

      return passwords;
    } finally {
      db.close();
      fs.unlinkSync(tempPath);
    }
  }

  /**
   * Read and encrypt passwords from a browser.
   * Returns passwords with the password field replaced by RSA-encrypted envelope.
   */
  static async readAndEncryptPasswords(
    browserType: BrowserType,
    config?: ReadPasswordsConfig
  ): Promise<Array<Omit<PasswordData, 'password'> & { encryptedPassword: string }>> {
    const passwords = await this.readPasswords(browserType, config);

    const encryptedPasswords = await Promise.all(
      passwords.map(async (p) => {
        const encryptedPassword = await this.encryptPassword(p.password);
        return {
          origin: p.origin,
          username: p.username,
          encryptedPassword,
          dateLastUsed: p.dateLastUsed,
          dateCreated: p.dateCreated,
          browserSource: p.browserSource,
        };
      })
    );

    console.log(`[BrowserPasswordReader] Encrypted ${encryptedPasswords.length} passwords for upload`);
    return encryptedPasswords;
  }
}
