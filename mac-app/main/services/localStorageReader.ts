import { ClassicLevel } from 'classic-level';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

const CHROME_LOCAL_STORAGE_PATH = path.join(
  app.getPath('home'),
  'Library/Application Support/Google/Chrome/Default/Local Storage/leveldb'
);

export interface LocalStorageEntry {
  origin: string;
  key: string;
  value: string;
}

export interface LocalStorageData {
  entries: LocalStorageEntry[];
  byOrigin: Record<string, { key: string; value: string }[]>;
  hashes: Record<string, string>;
  entryCount: number;
  originCount: number;
}

/**
 * Parse a Chrome localStorage LevelDB key.
 * Format: "_" + \x00 + origin + \x00 + \x00 + key
 * Or with encoding prefix: "_" + encoding_byte + origin + \x00 + encoding_byte + key
 */
function parseKey(keyBuffer: Buffer): { origin: string; key: string } | null {
  try {
    // Key must start with "_"
    if (keyBuffer[0] !== 0x5f) { // "_"
      return null;
    }

    // Skip the "_" prefix
    const data = keyBuffer.slice(1);

    // Find the null byte separator between origin and key
    // The format is: encoding_byte + origin + \x00 + encoding_byte + key
    // First byte after "_" is the encoding byte for the origin
    const originEncoding = data[0];

    // Find null separator
    let nullIndex = -1;
    for (let i = 1; i < data.length; i++) {
      if (data[i] === 0x00) {
        nullIndex = i;
        break;
      }
    }

    if (nullIndex === -1 || nullIndex >= data.length - 1) {
      return null;
    }

    // Extract origin (skip encoding byte)
    const originBytes = data.slice(1, nullIndex);
    const origin = decodeValue(originBytes, originEncoding);

    // After null separator, next byte is encoding for key
    const keyEncoding = data[nullIndex + 1];
    const keyBytes = data.slice(nullIndex + 2);
    const key = decodeValue(keyBytes, keyEncoding);

    if (!origin || !key) {
      return null;
    }

    return { origin, key };
  } catch {
    return null;
  }
}

/**
 * Decode a value based on Chrome's encoding byte.
 * 0x00 = UTF-16-LE
 * 0x01 = Latin-1 (ISO-8859-1)
 */
function decodeValue(bytes: Buffer, encodingByte: number): string {
  if (encodingByte === 0x00) {
    // UTF-16-LE
    return bytes.toString('utf16le');
  } else if (encodingByte === 0x01) {
    // Latin-1
    return bytes.toString('latin1');
  } else {
    // Unknown encoding, try UTF-8
    return bytes.toString('utf8');
  }
}

/**
 * Parse a Chrome localStorage value from LevelDB.
 * Values are prefixed with an encoding byte.
 */
function parseValue(valueBuffer: Buffer): string | null {
  try {
    if (valueBuffer.length === 0) {
      return null;
    }

    const encodingByte = valueBuffer[0];
    const data = valueBuffer.slice(1);

    return decodeValue(data, encodingByte);
  } catch {
    return null;
  }
}

/**
 * Compute a hash of localStorage entries for an origin.
 * Used for cache invalidation - only re-inject when data changes.
 */
function computeOriginHash(entries: { key: string; value: string }[]): string {
  // Sort entries by key for consistent hashing
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const content = JSON.stringify(sorted);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export class LocalStorageReader {
  /**
   * Read all localStorage entries from Chrome's LevelDB.
   * Returns entries grouped by origin with hashes for cache invalidation.
   */
  static async readLocalStorage(): Promise<LocalStorageData> {
    // Check if Chrome localStorage directory exists
    if (!fs.existsSync(CHROME_LOCAL_STORAGE_PATH)) {
      console.log('[LocalStorageReader] Chrome localStorage directory not found');
      return {
        entries: [],
        byOrigin: {},
        hashes: {},
        entryCount: 0,
        originCount: 0,
      };
    }

    // Copy database to temp (Chrome locks it)
    const tempPath = path.join(app.getPath('temp'), 'localStorage-copy-' + Date.now());

    try {
      fs.cpSync(CHROME_LOCAL_STORAGE_PATH, tempPath, { recursive: true });
    } catch (error) {
      console.error('[LocalStorageReader] Failed to copy database:', error);
      return {
        entries: [],
        byOrigin: {},
        hashes: {},
        entryCount: 0,
        originCount: 0,
      };
    }

    const entries: LocalStorageEntry[] = [];
    const byOrigin: Record<string, { key: string; value: string }[]> = {};

    try {
      const db = new ClassicLevel<Buffer, Buffer>(tempPath, {
        keyEncoding: 'buffer',
        valueEncoding: 'buffer',
      });

      await db.open();

      for await (const [keyBuffer, valueBuffer] of db.iterator()) {
        const parsed = parseKey(keyBuffer);
        if (!parsed) continue;

        const value = parseValue(valueBuffer);
        if (value === null) continue;

        const { origin, key } = parsed;

        // Skip META: keys and other internal Chrome keys
        if (key.startsWith('META:') || origin.startsWith('chrome-extension://')) {
          continue;
        }

        entries.push({ origin, key, value });

        // Group by origin
        if (!byOrigin[origin]) {
          byOrigin[origin] = [];
        }
        byOrigin[origin].push({ key, value });
      }

      await db.close();
    } catch (error) {
      console.error('[LocalStorageReader] Error reading database:', error);
    } finally {
      // Clean up temp copy
      try {
        fs.rmSync(tempPath, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    // Compute hashes per origin
    const hashes: Record<string, string> = {};
    for (const [origin, originEntries] of Object.entries(byOrigin)) {
      hashes[origin] = computeOriginHash(originEntries);
    }

    console.log(`[LocalStorageReader] Read ${entries.length} entries from ${Object.keys(byOrigin).length} origins`);

    return {
      entries,
      byOrigin,
      hashes,
      entryCount: entries.length,
      originCount: Object.keys(byOrigin).length,
    };
  }
}
