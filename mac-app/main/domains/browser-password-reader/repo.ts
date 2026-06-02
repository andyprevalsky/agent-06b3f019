/**
 * Repo layer for browser-password-reader.
 *
 * Owns every side-effecting boundary the domain touches:
 *   - Filesystem: existsSync, statSync, copyFileSync, unlinkSync
 *   - glob.sync for wildcard login-data-path patterns
 *   - macOS Keychain read via the `security(1)` CLI
 *   - SQLite via better-sqlite3 (read-only handle on a copied DB file)
 *
 * The service layer never shells out, touches `fs`, or opens a DB directly —
 * it composes the typed, framework-agnostic helpers exposed here.
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import { glob } from 'glob';
import {
  PBKDF2_DIGEST,
  PBKDF2_ITERATIONS,
  PBKDF2_KEY_LENGTH,
  PBKDF2_SALT,
  tempLoginDataFilename,
} from './config';
import type { BrowserType, LoginRow } from './types';

const execAsync = promisify(exec);

/**
 * Resolve a login-data path pattern that may contain wildcards. Returns
 * the first matching path (most-recently-modified when multiple candidates
 * exist), or null if no match is found on disk.
 */
export function resolveLoginDataPath(pattern: string): string | null {
  return resolveLoginDataPaths(pattern)[0] ?? null;
}

/**
 * Resolve every login-data path matching a pattern, newest file first. Used
 * by Chrome, where each profile owns a separate `Login Data` DB and sync must
 * consider all profiles before deduping credentials.
 */
export function resolveLoginDataPaths(pattern: string): string[] {
  if (!pattern.includes('*')) {
    return fs.existsSync(pattern) ? [pattern] : [];
  }

  const matches = glob.sync(pattern);
  if (matches.length === 0) {
    return [];
  }

  return matches
    .map((p) => ({ path: p, mtime: fs.statSync(p).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((match) => match.path);
}

/**
 * Fetch the Safe Storage password for a given keychain account via the
 * `security(1)` CLI. Rejection (missing entry, user-denied, unknown error)
 * propagates — the service layer maps it to a friendlier message.
 */
export async function fetchKeychainPassword(keychainAccount: string): Promise<string> {
  const { stdout } = await execAsync(`security find-generic-password -wa "${keychainAccount}"`);
  return stdout.trim();
}

/**
 * Derive the AES-128 key every Chromium-family browser uses on macOS from
 * its Safe Storage password. Parameters are fixed by Chromium.
 */
export function deriveAesKey(password: string): Buffer {
  return crypto.pbkdf2Sync(
    password,
    PBKDF2_SALT,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LENGTH,
    PBKDF2_DIGEST
  );
}

/**
 * Handle owned by the caller for the copied DB + its temp file. The caller
 * is responsible for invoking `close()` once it has drained rows — that
 * tears down the DB handle and unlinks the on-disk copy.
 */
export interface LoginsDbHandle {
  queryLoginRows(): LoginRow[];
  close(): void;
  readonly tempPath: string;
}

/**
 * Copy the (browser-locked) Login Data DB to a per-browser temp path and
 * open a read-only handle against the copy. The temp path is browser-scoped
 * so concurrent reads across browsers never collide.
 */
export function openLoginsDbCopy(sourcePath: string, browserType: BrowserType): LoginsDbHandle {
  const tempPath = path.join(app.getPath('temp'), tempLoginDataFilename(browserType));
  fs.copyFileSync(sourcePath, tempPath);

  const db = new Database(tempPath, { readonly: true });

  return {
    tempPath,
    queryLoginRows(): LoginRow[] {
      return db
        .prepare(
          `
          SELECT
            origin_url,
            username_value,
            password_value,
            date_last_used,
            date_created
          FROM logins
          WHERE blacklisted_by_user = 0
          ORDER BY date_last_used DESC
        `
        )
        .all() as LoginRow[];
    },
    close(): void {
      db.close();
      fs.unlinkSync(tempPath);
    },
  };
}
