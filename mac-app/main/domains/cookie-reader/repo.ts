/**
 * Repo layer for cookie-reader.
 *
 * Owns every side-effecting boundary the domain touches:
 *   - macOS Keychain read via the `security(1)` CLI
 *   - Filesystem: mkdtempSync / copyFileSync / unlinkSync / rmdirSync
 *   - SQLite via better-sqlite3 (read-only handle on a copied DB file)
 *   - Chrome profile resolution (shared service used by other readers)
 *
 * Service layer never shells out, touches `fs`, or opens a DB directly — it
 * composes these typed, framework-agnostic helpers.
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { resolveChromeProfilePath } from '../../services/chromeProfileResolver';
import {
  CHROME_SAFE_STORAGE_SERVICE,
  PBKDF2_DIGEST,
  PBKDF2_ITERATIONS,
  PBKDF2_KEY_LENGTH,
  PBKDF2_SALT,
  TEMP_DB_FILENAME,
  TEMP_DIR_PREFIX,
} from './config';
import type { CookieRow } from './types';

const execAsync = promisify(exec);

/**
 * Resolve the path to the active Chrome profile's `Cookies` SQLite file, or
 * return null if Chrome is not installed / no profile was found.
 */
export function findChromeCookiesPath(): string | null {
  return resolveChromeProfilePath('Cookies');
}

/**
 * Fetch the Chrome Safe Storage password from the macOS Keychain and derive
 * the AES-128 key Chrome uses to encrypt cookie values.
 *
 * Any failure of the `security` CLI (denial, missing entry, user-cancel)
 * propagates to the caller as a rejected promise — the service layer maps
 * that to an abort.
 */
export async function fetchChromeEncryptionKey(): Promise<Buffer> {
  const { stdout } = await execAsync(
    `security find-generic-password -wa "${CHROME_SAFE_STORAGE_SERVICE}"`
  );
  const password = stdout.trim();
  return crypto.pbkdf2Sync(
    password,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST
  );
}

/**
 * Handle owned by the caller for the copied DB + its temp dir. The caller is
 * responsible for invoking `close()` once it has drained rows — that cleans
 * up both the DB handle and the on-disk copy.
 */
export interface CookiesDbHandle {
  queryCookieRows(): CookieRow[];
  close(): void;
}

/**
 * Copy the (Chrome-locked) cookies DB to a per-invocation temp dir and open
 * a read-only handle against the copy. Returns a handle whose `close()` tears
 * down the DB, unlinks the copy, and removes the temp dir — best-effort.
 */
export function openCookiesDbCopy(sourcePath: string): CookiesDbHandle {
  const tempDir = fs.mkdtempSync(path.join(app.getPath('temp'), TEMP_DIR_PREFIX));
  const tempPath = path.join(tempDir, TEMP_DB_FILENAME);
  fs.copyFileSync(sourcePath, tempPath);

  const db = new Database(tempPath, { readonly: true });

  return {
    queryCookieRows(): CookieRow[] {
      return db
        .prepare(
          `
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
        `
        )
        .all() as CookieRow[];
    },
    close(): void {
      db.close();
      // Best-effort cleanup of the per-invocation temp copy + dir.
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // File may have been removed by another process.
      }
      try {
        fs.rmdirSync(tempDir);
      } catch {
        // Directory may have been removed or contain other files.
      }
    },
  };
}
