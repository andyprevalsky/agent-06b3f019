/**
 * Integrations upload service — shared crypto helpers + re-exports.
 * Sub-modules: uploadService.contacts.ts, uploadService.messaging.ts,
 *              uploadService.browser.ts, uploadService.passwords.ts
 */

import { createDecipheriv } from '../../providers/crypto';

// Re-export everything from sub-modules so service.ts imports stay unchanged
export {
  processGenericUpload,
  processLinkedInUpload,
  processContactsUpload,
  processEmailZipUpload,
} from './uploadService.contacts';

export {
  processIMessageUpload,
  processWhatsAppConnect,
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
  ingestIndexedDBUploadJson,
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

export { processPasskeysUpload } from './uploadService.passkeys';

export { processDocumentsUpload } from './uploadService.documents';

// ---------------------------------------------------------------------------
// Shared crypto helpers
// ---------------------------------------------------------------------------

/**
 * Decrypt AES-256-CBC encrypted payload.
 */
export function decryptPayload<T>(data: string, iv: string, key: string): T {
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));
  let decrypted = decipher.update(data, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted) as T;
}

/**
 * Decrypt and optionally decompress AES-256-CBC encrypted payload to UTF-8
 * JSON text without parsing it into a V8 object graph.
 */
export async function decryptCompressedToUtf8(
  data: string,
  iv: string,
  key: string,
  compressed: string | undefined
): Promise<string> {
  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));

  const decryptedBuffer = Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]);

  if (compressed === 'true') {
    const zlib = await import('zlib');
    const { promisify } = await import('util');
    const gunzip = promisify(zlib.gunzip);
    const decompressed = await gunzip(decryptedBuffer);
    return decompressed.toString('utf8');
  }
  return decryptedBuffer.toString('utf8');
}

/**
 * Decrypt and optionally decompress AES-256-CBC encrypted payload.
 *
 * Avoid this for IndexedDB / other blob-origin uploads — JSON.parse of a
 * multi-megabyte `databases` field OOMs the process. Use
 * {@link decryptCompressedToUtf8} + a text/Postgres ingest path instead.
 */
export async function decryptCompressedPayload<T>(
  data: string,
  iv: string,
  key: string,
  compressed: string | undefined
): Promise<T> {
  const jsonString = await decryptCompressedToUtf8(data, iv, key, compressed);
  return JSON.parse(jsonString) as T;
}
