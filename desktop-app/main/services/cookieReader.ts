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
    
    // Derive AES key
    const salt = 'saltysalt';
    const iterations = 1003;
    return crypto.pbkdf2Sync(password, salt, iterations, 16, 'sha1');
  }
  
  private static decryptValue(encryptedValue: Buffer, key: Buffer): string {
    if (encryptedValue.slice(0, 3).toString() !== 'v10') {
      throw new Error('Unknown cookie encryption version');
    }
    
    const nonce = encryptedValue.slice(3, 15);
    const ciphertext = encryptedValue.slice(15, -16);
    const tag = encryptedValue.slice(-16);
    
    const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(tag);
    
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
    
    return decrypted.toString('utf8');
  }
  
  static async readCookies(): Promise<CookieData[]> {
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
      
      return rows.map((row) => ({
        host_key: row.host_key,
        name: row.name,
        value: this.decryptValue(row.encrypted_value, key),
        path: row.path,
        expires_utc: row.expires_utc,
        is_secure: row.is_secure === 1,
        is_httponly: row.is_httponly === 1,
      }));
    } finally {
      db.close();
      fs.unlinkSync(tempPath);
    }
  }
}


