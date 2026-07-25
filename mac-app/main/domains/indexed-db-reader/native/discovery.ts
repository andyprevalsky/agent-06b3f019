/**
 * Chrome profile / IndexedDB folder discovery.
 *
 * Faithful port of the folder-location logic that used to live in
 * `scripts/read_indexeddb.py` (`find_chrome_profile_dir`,
 * `find_indexeddb_folders`, and the origin/blob-dir derivation in
 * `read_indexeddb`). Kept separate from the decoder so it can be unit-tested
 * against a synthetic profile tree.
 */

import fs from 'fs';
import path from 'path';

/** A discovered IndexedDB store on disk. */
export interface IndexedDbFolder {
  /** Absolute path to the `*.indexeddb.leveldb` directory. */
  leveldbDir: string;
  /** Absolute path to the sibling `*.indexeddb.blob` dir, if it exists. */
  blobDir: string | null;
  /** The raw folder name, e.g. `https_www.amazon.com_0.indexeddb.leveldb`. */
  folderName: string;
  /** The reconstructed origin, e.g. `https://www.amazon.com`. */
  origin: string;
}

const LEVELDB_SUFFIX = '.indexeddb.leveldb';
const BLOB_SUFFIX = '.indexeddb.blob';

/** The Chrome user-data root under a home directory (macOS layout). */
export function chromeUserDataDir(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
}

/**
 * Find the active Chrome profile directory (Default, Profile 1, …) — the one
 * whose `Preferences` file was most recently modified. Mirrors
 * `find_chrome_profile_dir`.
 */
export function findActiveChromeProfileDir(home: string): string | null {
  const base = chromeUserDataDir(home);
  if (!fs.existsSync(base)) return null;

  let newest: { dir: string; mtimeMs: number } | null = null;
  for (const entry of fs.readdirSync(base)) {
    const prefs = path.join(base, entry, 'Preferences');
    if (!fs.existsSync(prefs)) continue;
    const mtimeMs = fs.statSync(prefs).mtimeMs;
    if (newest === null || mtimeMs > newest.mtimeMs) {
      newest = { dir: path.join(base, entry), mtimeMs };
    }
  }
  return newest?.dir ?? null;
}

/** Reconstruct an origin from a `*.indexeddb.leveldb` folder name. Mirrors `read_indexeddb`. */
export function originFromFolderName(folderName: string): string {
  const originPart = folderName.replace(LEVELDB_SUFFIX, '');
  const stripScheme = (rest: string): string => {
    const lastUnderscore = rest.lastIndexOf('_');
    const host = lastUnderscore === -1 ? rest : rest.slice(0, lastUnderscore);
    return host.replace(/_/g, '.');
  };
  if (originPart.startsWith('https_')) return `https://${stripScheme(originPart.slice(6))}`;
  if (originPart.startsWith('http_')) return `http://${stripScheme(originPart.slice(5))}`;
  return originPart;
}

/**
 * Enumerate IndexedDB folders in the active Chrome profile, optionally filtered
 * by a case-insensitive origin substring (e.g. `"amazon"`). Mirrors
 * `find_indexeddb_folders` + the blob-dir derivation.
 */
export function findIndexedDbFolders(home: string, originFilter?: string): IndexedDbFolder[] {
  const profileDir = findActiveChromeProfileDir(home);
  if (profileDir === null) return [];
  const idbBase = path.join(profileDir, 'IndexedDB');
  if (!fs.existsSync(idbBase)) return [];

  const filter = originFilter?.toLowerCase();
  const folders: IndexedDbFolder[] = [];
  for (const item of fs.readdirSync(idbBase)) {
    if (!item.endsWith(LEVELDB_SUFFIX)) continue;
    if (filter !== undefined && !item.toLowerCase().includes(filter)) continue;
    const leveldbDir = path.join(idbBase, item);
    const blobCandidate = path.join(idbBase, item.replace(LEVELDB_SUFFIX, BLOB_SUFFIX));
    folders.push({
      leveldbDir,
      blobDir: fs.existsSync(blobCandidate) ? blobCandidate : null,
      folderName: item,
      origin: originFromFolderName(item),
    });
  }
  return folders;
}
