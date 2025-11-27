import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import type { CookieData } from '../../shared/types/ipc';

const execAsync = promisify(exec);

const CHROME_COOKIES_PATH = path.join(
  app.getPath('home'),
  'Library/Application Support/Google/Chrome/Default/Cookies'
);

export class CookieReader {
  private static async getEncryptionKey(): Promise<Buffer> {
    // Get Chrome Safe Storage key from macOS Keychain
    const { stdout } = await execAsync(
      'security find-generic-password -wa "Chrome"'
    );
    const password = stdout.trim();
    
    // Derive AES key using PBKDF2-SHA1
    // Chrome uses: salt="saltysalt", iterations=1003, key_length=16
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
      return data; // Invalid padding, return as-is
    }
    // Verify padding bytes
    for (let i = data.length - paddingLength; i < data.length; i++) {
      if (data[i] !== paddingLength) {
        return data; // Invalid padding, return as-is
      }
    }
    return data.slice(0, data.length - paddingLength);
  }
  
  /**
   * Chrome on macOS prepends 32 bytes of random data before the actual cookie value
   * during encryption. After decryption, we need to skip these 32 bytes.
   * Format: [32 bytes random] + [actual value] + [PKCS7 padding]
   */
  private static readonly CHROME_PREFIX_LENGTH = 32;
  
  /**
   * Decrypt a Chrome cookie value.
   * Chrome on macOS uses AES-128-CBC with a fixed IV of 16 spaces.
   * Returns null if decryption fails (cookie will be skipped).
   */
  private static decryptValue(encryptedValue: Buffer, key: Buffer): string | null {
    // Handle empty or null values
    if (!encryptedValue || encryptedValue.length === 0) {
      return null;
    }
    
    // Check for v10 encryption prefix (Chrome on macOS)
    const prefix = encryptedValue.slice(0, 3).toString();
    if (prefix !== 'v10') {
      // Could be unencrypted (plaintext) or different version
      // Try to return as string if it looks like text
      const asString = encryptedValue.toString('utf8');
      if (asString && /^[\x20-\x7E]*$/.test(asString)) {
        return asString; // Appears to be plaintext ASCII
      }
      return null; // Unknown format, skip
    }
    
    // v10 format: 3 bytes prefix + ciphertext
    // Need at least the prefix + 1 block of ciphertext
    if (encryptedValue.length < 4) {
      return null;
    }
    
    try {
      // Chrome on macOS uses AES-128-CBC with a fixed IV of 16 space characters
      const iv = Buffer.alloc(16, ' '); // 16 space characters
      const ciphertext = encryptedValue.slice(3); // Skip 'v10' prefix
      
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      decipher.setAutoPadding(false); // We'll handle padding manually
      
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);
      
      // Remove PKCS7 padding
      const unpadded = this.removePKCS7Padding(decrypted);
      
      // Chrome prepends 32 bytes of random data - skip it
      if (unpadded.length > this.CHROME_PREFIX_LENGTH) {
        return unpadded.slice(this.CHROME_PREFIX_LENGTH).toString('utf8');
      }
      
      // If unpadded length is exactly 32 or less, the cookie value is empty
      // (Chrome only stored the random prefix, no actual value)
      return '';
    } catch (error) {
      // Decryption failed - corrupted cookie or wrong key
      return null;
    }
  }
  
  static async readCookies(): Promise<CookieData[]> {
    // Check if Chrome cookies file exists
    if (!fs.existsSync(CHROME_COOKIES_PATH)) {
      console.log('[CookieReader] Chrome cookies file not found');
      return [];
    }
    
    // Copy database (Chrome locks it)
    const tempPath = path.join(app.getPath('temp'), 'Cookies-copy');
    fs.copyFileSync(CHROME_COOKIES_PATH, tempPath);
    
    const db = new Database(tempPath, { readonly: true });
    const key = await this.getEncryptionKey();
    
    try {
      const rows = db.prepare(`
        SELECT 
          host_key,
          name,
          encrypted_value,
          path,
          expires_utc,
          is_secure,
          is_httponly
        FROM cookies
      `).all() as any[];
      
      const cookies: CookieData[] = [];
      let skipped = 0;
      
      for (const row of rows) {
        const value = this.decryptValue(row.encrypted_value, key);
        
        // Skip cookies that couldn't be decrypted or have empty values
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
        });
      }
      
      console.log(`[CookieReader] Read ${cookies.length} cookies (skipped ${skipped} unreadable)`);
      return cookies;
    } finally {
      db.close();
      fs.unlinkSync(tempPath);
    }
  }
}

