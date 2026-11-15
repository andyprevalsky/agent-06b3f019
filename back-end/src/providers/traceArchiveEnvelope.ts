import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { EncryptedArtifactMetadata } from './traceArchive';

/**
 * Archive ingest bounds (every path: worker batch, worker single artifact and
 * backend-internal writers). Records are never dropped for being large:
 *   - plaintext ≤ 1 GiB is only a decompression-bomb guard (browser step
 *     records grow ~0.3 MB/step; a 32 MiB cap silently dropped late steps);
 *   - ciphertext ≤ 72 MiB keeps one base64 record (×4/3 = 96 MiB) inside the
 *     100mb express.json body limit (server.ts).
 */
export const ARCHIVE_MAX_PLAINTEXT_BYTES = 1024 * 1024 * 1024;
export const ARCHIVE_MAX_CIPHERTEXT_BYTES = 72 * 1024 * 1024;

export function metadataFromUnknown(value: unknown): EncryptedArtifactMetadata {
  if (value === null || typeof value !== 'object') {
    throw new Error('Archive metadata is missing');
  }
  const metadata = value as EncryptedArtifactMetadata;
  const requiredStringFields: (keyof EncryptedArtifactMetadata)[] = [
    'path',
    'content_type',
    'compression',
    'encryption',
    'encryption_key_id',
    'nonce_b64',
    'auth_tag_b64',
    'aad',
    'plaintext_sha256',
    'ciphertext_sha256',
  ];
  for (const field of requiredStringFields) {
    if (typeof metadata[field] !== 'string') throw new Error(`Archive metadata missing ${field}`);
  }
  const requiredNumberFields: (keyof EncryptedArtifactMetadata)[] = [
    'plaintext_bytes',
    'stored_plaintext_bytes',
    'ciphertext_bytes',
    'created_at_ms',
  ];
  for (const field of requiredNumberFields) {
    if (typeof metadata[field] !== 'number') throw new Error(`Archive metadata missing ${field}`);
  }
  if (metadata.encryption !== 'aes-256-gcm') {
    throw new Error(`Unsupported archive encryption ${metadata.encryption}`);
  }
  if (metadata.compression !== 'gzip' && metadata.compression !== 'none') {
    throw new Error(`Unsupported archive compression ${metadata.compression}`);
  }
  return metadata;
}

export function validateEncryptedArtifactEnvelope(params: {
  objectPath: string;
  ciphertext: Buffer;
  metadata: unknown;
}): EncryptedArtifactMetadata {
  const metadata = metadataFromUnknown(params.metadata);
  if (metadata.path !== params.objectPath) {
    throw new Error(`Archive metadata path mismatch: ${metadata.path} !== ${params.objectPath}`);
  }
  if (metadata.aad !== params.objectPath) {
    throw new Error(`Archive metadata AAD mismatch: ${metadata.aad} !== ${params.objectPath}`);
  }
  if (metadata.ciphertext_bytes !== params.ciphertext.length) {
    throw new Error('Archive ciphertext byte count mismatch');
  }
  if (params.ciphertext.length > ARCHIVE_MAX_CIPHERTEXT_BYTES) {
    throw new Error('Archive ciphertext exceeds bounds');
  }
  if (
    !Number.isSafeInteger(metadata.plaintext_bytes) ||
    metadata.plaintext_bytes < 0 ||
    metadata.plaintext_bytes > ARCHIVE_MAX_PLAINTEXT_BYTES
  ) {
    throw new Error('Archive plaintext byte count exceeds bounds');
  }
  const ciphertextSha = crypto.createHash('sha256').update(params.ciphertext).digest('hex');
  if (metadata.ciphertext_sha256 !== ciphertextSha) {
    throw new Error('Archive ciphertext SHA-256 mismatch');
  }
  if (Buffer.from(metadata.nonce_b64, 'base64').length !== 12) {
    throw new Error('Archive nonce must be 12 bytes');
  }
  if (Buffer.from(metadata.auth_tag_b64, 'base64').length !== 16) {
    throw new Error('Archive auth tag must be 16 bytes');
  }
  return metadata;
}

export function decryptAndValidateArtifact(params: {
  ciphertext: Buffer;
  metadata: EncryptedArtifactMetadata;
  encryptionKey: Buffer | null;
}): Buffer {
  const { ciphertext, metadata } = params;
  const ciphertextSha = crypto.createHash('sha256').update(ciphertext).digest('hex');
  if (ciphertextSha !== metadata.ciphertext_sha256) {
    throw new Error('Archive ciphertext SHA-256 mismatch');
  }
  if (ciphertext.length !== metadata.ciphertext_bytes) {
    throw new Error('Archive ciphertext byte count mismatch');
  }
  if (params.encryptionKey === null) throw new Error('Archive encryption key is unavailable');
  const tag = Buffer.from(metadata.auth_tag_b64, 'base64');
  const encrypted = ciphertext.subarray(0, ciphertext.length - tag.length);
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    params.encryptionKey,
    Buffer.from(metadata.nonce_b64, 'base64')
  );
  decipher.setAAD(Buffer.from(metadata.aad, 'utf8'));
  decipher.setAuthTag(tag);
  const storedPlaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (storedPlaintext.length !== metadata.stored_plaintext_bytes) {
    throw new Error('Archive stored plaintext byte count mismatch');
  }
  const plaintext =
    metadata.compression === 'gzip'
      ? zlib.gunzipSync(storedPlaintext, { maxOutputLength: ARCHIVE_MAX_PLAINTEXT_BYTES })
      : storedPlaintext;
  if (plaintext.length !== metadata.plaintext_bytes) {
    throw new Error('Archive plaintext byte count mismatch');
  }
  const plaintextSha = crypto.createHash('sha256').update(plaintext).digest('hex');
  if (plaintextSha !== metadata.plaintext_sha256) {
    throw new Error('Archive plaintext SHA-256 mismatch');
  }
  return plaintext;
}
