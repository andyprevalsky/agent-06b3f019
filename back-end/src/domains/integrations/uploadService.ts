/**
 * Integrations upload service — shared crypto helpers + re-exports.
 * Sub-modules: uploadService.contacts.ts, uploadService.messaging.ts,
 *              uploadService.browser.ts, uploadService.passwords.ts
 */

import { createDecipheriv } from '../../providers/crypto';
import { IndexedDBUploadPayloadTooLargeError } from './types';

// Re-export everything from sub-modules so service.ts imports stay unchanged
export {
  processGenericUpload,
  processLinkedInUpload,
  LinkedInArchiveWithoutConnectionsError,
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
/** Decompressed IndexedDB/local upload ceiling (UTF-8 bytes). Shared with ingest. */
const MAX_DECOMPRESSED_UPLOAD_BYTES = 64 * 1024 * 1024;
/** Reject ciphertext that cannot possibly gunzip into the ceiling (hex chars). */
const MAX_ENCRYPTED_HEX_CHARS = MAX_DECOMPRESSED_UPLOAD_BYTES * 4;

export async function decryptCompressedToUtf8(
  data: string,
  iv: string,
  key: string,
  compressed: string | undefined
): Promise<string> {
  if (typeof data !== 'string' || data.length > MAX_ENCRYPTED_HEX_CHARS) {
    throw new IndexedDBUploadPayloadTooLargeError(
      MAX_DECOMPRESSED_UPLOAD_BYTES,
      Math.ceil((typeof data === 'string' ? data.length : 0) / 2)
    );
  }

  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(key, 'hex'), Buffer.from(iv, 'hex'));

  const decryptedBuffer = Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]);

  if (compressed === 'true') {
    const zlib = await import('zlib');
    const { promisify } = await import('util');
    const gunzip = promisify(zlib.gunzip);
    let decompressed: Buffer;
    try {
      decompressed = await gunzip(decryptedBuffer, {
        maxOutputLength: MAX_DECOMPRESSED_UPLOAD_BYTES,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/Cannot create a Buffer larger|maxOutputLength|exceeds|too large|memory/i.test(message)) {
        throw new IndexedDBUploadPayloadTooLargeError(
          MAX_DECOMPRESSED_UPLOAD_BYTES,
          MAX_DECOMPRESSED_UPLOAD_BYTES + 1
        );
      }
      throw err;
    }
    return decompressed.toString('utf8');
  }
  if (decryptedBuffer.length > MAX_DECOMPRESSED_UPLOAD_BYTES) {
    throw new IndexedDBUploadPayloadTooLargeError(
      MAX_DECOMPRESSED_UPLOAD_BYTES,
      decryptedBuffer.length
    );
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
