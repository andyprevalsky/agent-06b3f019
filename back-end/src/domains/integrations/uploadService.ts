/**
 * Integrations upload service — shared crypto helpers + re-exports.
 * Sub-modules: uploadService.contacts.ts, uploadService.messaging.ts,
 *              uploadService.browser.ts, uploadService.passwords.ts
 */

import crypto from 'crypto';

// Re-export everything from sub-modules so service.ts imports stay unchanged
export {
  processGenericUpload,
  processLinkedInUpload,
  processContactsUpload,
  processEmailZipUpload,
} from './uploadService.contacts';

export {
  processIMessageUpload,
  processWhatsAppUpload,
  processTelegramConnect,
  processTelegramUpload,
} from './uploadService.messaging';

export type {
  ContactWithMessages,
  WhatsAppContactWithMessages,
  TelegramContactWithMessages,
} from './uploadService.messaging';

export {
  processCookiesUpload,
  processLocalStorageUpload,
  processIndexedDBUpload,
  processFingerprintUpload,
  processPermissionsUpload,
} from './uploadService.browser';

export {
  processCacheStorageUpload,
  processPasswordsUpload,
  encryptPasswordForStorage,
  parseApplePasswordsCsv,
  processApplePasswordsUpload,
} from './uploadService.passwords';

// ---------------------------------------------------------------------------
// Shared crypto helpers
// ---------------------------------------------------------------------------

/**
 * Decrypt AES-256-CBC encrypted payload.
 */
export function decryptPayload<T>(data: string, iv: string, key: string): T {
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(key, 'hex'),
    Buffer.from(iv, 'hex')
  );
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted) as T;
}

/**
 * Decrypt and optionally decompress AES-256-CBC encrypted payload.
 */
export async function decryptCompressedPayload<T>(
  data: string,
  iv: string,
  key: string,
  compressed: string | undefined
): Promise<T> {
  const decipher = crypto.createDecipheriv(
    'aes-256-cbc',
    Buffer.from(key, 'hex'),
    Buffer.from(iv, 'hex')
  );

  const decryptedBuffer = Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]);

  let jsonString: string;
  if (compressed === 'true') {
    const zlib = await import('zlib');
    const { promisify } = await import('util');
    const gunzip = promisify(zlib.gunzip);
    const decompressed = await gunzip(decryptedBuffer);
    jsonString = decompressed.toString('utf8');
  } else {
    jsonString = decryptedBuffer.toString('utf8');
  }

  return JSON.parse(jsonString) as T;
}

/**
 * Sanitize string: remove null bytes that PostgreSQL can't store.
 */
export function sanitizeString(str: string): string {
  if (typeof str !== 'string') return str;
  // eslint-disable-next-line no-control-regex -- Intentionally removing null bytes and control chars for PostgreSQL compatibility
  return str.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

/**
 * Sanitize string for localStorage: also handles orphan Unicode surrogates.
 */
export function sanitizeStringFull(str: string): string {
  if (typeof str !== 'string') return str;
  // eslint-disable-next-line no-control-regex -- Intentionally removing null bytes and control chars for PostgreSQL compatibility
  const sanitized = str.replace(/\u0000/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  // Remove orphan Unicode surrogates character by character
  const chars = [...sanitized];
  const filtered: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const code = chars[i].charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff) {
      const nextCode = chars[i + 1]?.charCodeAt(0);
      if (nextCode !== undefined && nextCode >= 0xdc00 && nextCode <= 0xdfff) {
        filtered.push(chars[i], chars[i + 1]);
        i++;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // Low surrogate without preceding high - drop it
    } else {
      filtered.push(chars[i]);
    }
  }
  return filtered.join('');
}
