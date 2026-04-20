/**
 * Repo layer for browser-cookie-reader.
 *
 * Owns every side-effecting boundary the domain touches:
 *   - Filesystem: existsSync, statSync, copyFileSync, unlinkSync (TOCTOU-guarded)
 *   - glob.sync for wildcard cookie-path patterns
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
  tempDbFilename,
} from './config';
import type { BrowserType, CookieRow } from './types';

const execAsync = promisify(exec);

/**
 * Resolve a cookie path pattern that may contain wildcards. Returns the
 * first matching path (most-recently-modified when multiple candidates
 * exist), or null if no match survives a `stat` probe.
 */
export function resolveCookiePath(pattern: string): string | null {
  // If no wildcards, check directly.
  if (!pattern.includes('*')) {
    return fs.existsSync(pattern) ? pattern : null;
  }

  // Wildcard pattern — glob then pick the most recently modified candidate.
  const matches = glob.sync(pattern);
  if (matches.length === 0) {
    return null;
  }

  // Guard each stat against TOCTOU — a file could disappear between
  // glob.sync and statSync.
  const sorted = matches
    .map((p) => {
      try {
        return { path: p, mtime: fs.statSync(p).mtime.getTime() };
      } catch {
        return null;
      }
    })
    .filter((x): x is { path: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);

  return sorted.length > 0 ? sorted[0].path : null;
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
export interface CookiesDbHandle {
  queryCookieRows(): CookieRow[];
  close(): void;
}

/**
 * Copy the (browser-locked) cookies DB to a per-browser temp path and open
 * a read-only handle against the copy. The temp path is browser-scoped so
 * concurrent reads across browsers never collide.
 */
export function openCookiesDbCopy(sourcePath: string, browserType: BrowserType): CookiesDbHandle {
  const tempPath = path.join(app.getPath('temp'), tempDbFilename(browserType));
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
      // Best-effort cleanup of the per-invocation temp copy.
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // File may have been removed by another process.
      }
    },
  };
}
