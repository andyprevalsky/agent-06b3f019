import {
  localArchiveRoot,
  localObjectPath,
  objectKey,
  objectPrefix,
  safeArchivePath,
} from './traceArchivePaths';
import {
  type ArtifactCreation,
  getS3Client,
  isExistingObjectError,
  putLocal,
  putR2,
  resetS3Client,
  shouldResetS3ClientAfterError,
} from './traceArchiveWriteStorage';
export { localObjectPath, objectKey, safeArchivePath } from './traceArchivePaths';
export { getS3Client } from './traceArchiveWriteStorage';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  deleteLocalArchivedBundle,
  deleteR2ArchivedBundle,
  listLocalArchivedObjects,
  listR2ArchivedObjects,
} from './traceArchiveBundleStorage';
import { streamToBuffer } from './traceArchiveBody';
import {
  decryptAndValidateArtifact as decryptAndValidateArtifactEnvelope,
  metadataFromUnknown,
  validateEncryptedArtifactEnvelope as validateEncryptedEnvelope,
} from './traceArchiveEnvelope';
import { createLogger } from './logger';
import { retryDelayMs, sleep, withTraceArchiveRequestTimeout } from './traceArchiveRequest';
import { redactGmailArchive } from './traceArchiveGmailRedaction';
import { isBoundArchiveId } from './llmArchiveRecord';
import { assertR2ArchiveWriteAllowed } from './traceArchiveR2Guard';
import { reconcileLateArtifact } from './traceArchiveLateWrites';
import {
  type ArchiveDeletionRequest,
  assertUserRequestedDeletion,
} from './traceArchiveDeletionPolicy';
export { type ArchiveDeletionRequest, assertUserRequestedDeletion };

const log = createLogger('TraceArchive');

const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const MEDIA_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.mp4',
  '.m4a',
  '.mp3',
  '.wav',
  '.m3u8',
]);
const STORE_MAX_ATTEMPTS = 5;

export interface EncryptedArtifactMetadata {
  path: string;
  content_type: string;
  compression: 'gzip' | 'none';
  encryption: 'aes-256-gcm';
  encryption_key_id: string;
  nonce_b64: string;
  auth_tag_b64: string;
  aad: string;
  plaintext_sha256: string;
  ciphertext_sha256: string;
  plaintext_bytes: number;
  stored_plaintext_bytes: number;
  ciphertext_bytes: number;
  created_at_ms: number;
}

export interface StoreResult {
  ref: string;
  metadata: EncryptedArtifactMetadata;
}

export interface StoredEncryptedArtifact {
  ciphertext: Buffer;
  metadata: EncryptedArtifactMetadata;
}

export interface ArchivedObjectSummary {
  ref: string;
  path: string;
  metadata?: unknown;
}

export interface ArchiveBundleDeleteResult {
  rootAgentId: string;
  backend: string;
  deletedObjectCount: number;
}

/** Every bundle belongs to a real agent tree root or a documented `user-<id>` root. */
function requireBoundRoot(rootAgentId: string): void {
  if (!isBoundArchiveId(rootAgentId)) {
    throw new Error(
      `Archive root must be a bound agent or user root; refusing ${JSON.stringify(rootAgentId)}`
    );
  }
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.ENVIRONMENT === 'production';
}

export function archiveEnabled(): boolean {
  const raw = (process.env.TRACE_ARCHIVE_ENABLED || '').trim().toLowerCase();
  if (FALSE_VALUES.has(raw)) return false;
  if (TRUE_VALUES.has(raw)) return true;
  if (isProduction()) {
    return Boolean(
      process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_TRACE_ARCHIVE
    );
  }
  return true;
}

function encryptionKey(): Buffer | null {
  const raw = (process.env.TRACE_ARCHIVE_ENCRYPTION_KEY_B64 || '').trim();
  if (raw !== '') {
    const key = Buffer.from(raw, 'base64');
    if (key.length === 32) return key;
    log.warn('Bad TRACE_ARCHIVE_ENCRYPTION_KEY_B64 length', { bytes: key.length });
    return null;
  }
  if (isProduction()) {
    log.warn('Trace archive disabled: missing TRACE_ARCHIVE_ENCRYPTION_KEY_B64');
    return null;
  }
  return crypto.createHash('sha256').update('rose-trace-archive-dev-key').digest();
}

function shouldCompress(objectPath: string, contentType: string, compress?: boolean): boolean {
  if (compress !== undefined) return compress;
  const ext = path.extname(objectPath).toLowerCase();
  if (MEDIA_EXTENSIONS.has(ext)) return false;
  return (
    !contentType.startsWith('image/') &&
    !contentType.startsWith('video/') &&
    !contentType.startsWith('audio/')
  );
}

/**
 * Synthetic nonce for create-only writes: HMAC(key, path/AAD, stored bytes)
 * makes a retry of the same artifact produce byte-identical ciphertext, so an
 * attempt whose body landed but whose sidecar did not can be completed
 * idempotently. It hashes the exact bytes AES-GCM encrypts (after optional
 * gzip), so distinct encryption inputs never share a nonce under one key.
 */
function syntheticNonce(key: Buffer, objectPath: string, storedPlaintext: Buffer): Buffer {
  return crypto
    .createHmac('sha256', key)
    .update('rose-trace-archive-siv-v2\0')
    .update(objectPath)
    .update('\0')
    .update(crypto.createHash('sha256').update(storedPlaintext).digest())
    .digest()
    .subarray(0, 12);
}

export function encryptArtifact(
  objectPath: string,
  plaintext: Buffer,
  contentType: string,
  compress?: boolean,
  options: { deterministic?: boolean } = {}
): { ciphertext: Buffer; metadata: EncryptedArtifactMetadata } | null {
  const key = encryptionKey();
  if (key === null) return null;

  const normalizedPath = safeArchivePath(objectPath);
  const useGzip = shouldCompress(normalizedPath, contentType, compress);
  const storedPlaintext = useGzip ? zlib.gzipSync(plaintext, { level: 6 }) : plaintext;
  const nonce = options.deterministic
    ? syntheticNonce(key, normalizedPath, storedPlaintext)
    : crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(normalizedPath, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(storedPlaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]);

  return {
    ciphertext,
    metadata: {
      path: normalizedPath,
      content_type: contentType,
      compression: useGzip ? 'gzip' : 'none',
      encryption: 'aes-256-gcm',
      encryption_key_id: process.env.TRACE_ARCHIVE_KEY_ID || 'dev-local',
      nonce_b64: nonce.toString('base64'),
      auth_tag_b64: authTag.toString('base64'),
      aad: normalizedPath,
      plaintext_sha256: crypto.createHash('sha256').update(plaintext).digest('hex'),
      ciphertext_sha256: crypto.createHash('sha256').update(ciphertext).digest('hex'),
      plaintext_bytes: plaintext.length,
      stored_plaintext_bytes: storedPlaintext.length,
      ciphertext_bytes: ciphertext.length,
      created_at_ms: Date.now(),
    },
  };
}

export function isMissingObjectError(error: unknown): boolean {
  const response = (error as { $metadata?: { httpStatusCode?: unknown }; name?: unknown }) ?? {};
  return (
    response.$metadata?.httpStatusCode === 404 ||
    response.name === 'NoSuchKey' ||
    response.name === 'NotFound'
  );
}

export function validateEncryptedArtifactEnvelope(params: {
  objectPath: string;
  ciphertext: Buffer;
  metadata: unknown;
}): EncryptedArtifactMetadata {
  return validateEncryptedEnvelope({
    ...params,
    objectPath: safeArchivePath(params.objectPath),
  });
}

export function readLocalObject(
  rootAgentId: string,
  objectPath: string
): StoredEncryptedArtifact | null {
  const target = localObjectPath(rootAgentId, objectPath);
  if (!fs.existsSync(target)) return null;
  const metadataPath = `${target}.meta.json`;
  if (!fs.existsSync(metadataPath)) throw new Error(`Archive metadata missing for ${objectPath}`);
  return {
    ciphertext: fs.readFileSync(target),
    metadata: metadataFromUnknown(JSON.parse(fs.readFileSync(metadataPath, 'utf8'))),
  };
}

export async function getR2Object(bucket: string, key: string): Promise<Buffer> {
  return withTraceArchiveRequestTimeout(async (abortSignal) => {
    const response = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal,
    });
    return streamToBuffer(response.Body, abortSignal);
  });
}

export async function readR2ObjectStrict(
  rootAgentId: string,
  objectPath: string
): Promise<StoredEncryptedArtifact | null> {
  const bucket = process.env.R2_BUCKET_TRACE_ARCHIVE || '';
  if (bucket === '') return null;
  const key = objectKey(rootAgentId, objectPath);
  try {
    const [ciphertext, metadataBuffer] = await Promise.all([
      getR2Object(bucket, key),
      getR2Object(bucket, `${key}.meta.json`),
    ]);
    return {
      ciphertext,
      metadata: metadataFromUnknown(JSON.parse(metadataBuffer.toString('utf8'))),
    };
  } catch (error) {
    if (isMissingObjectError(error)) return null;
    throw error;
  }
}

async function readR2Object(
  rootAgentId: string,
  objectPath: string
): Promise<StoredEncryptedArtifact | null> {
  try {
    return await readR2ObjectStrict(rootAgentId, objectPath);
  } catch (error) {
    log.warn('Trace archive read failed', {
      root_agent_id: rootAgentId,
      object_path: objectPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function storeEncryptedArtifact(params: {
  rootAgentId: string;
  objectPath: string;
  ciphertext: Buffer;
  metadata?: unknown;
  contentType?: string;
  createOnly?: boolean;
}): Promise<string | null> {
  if (!archiveEnabled()) return null;
  requireBoundRoot(params.rootAgentId);
  const backend = (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase();
  if (backend === 'r2' || (isProduction() && backend !== 'local' && backend !== 'fake-r2')) {
    assertR2ArchiveWriteAllowed();
  }
  const contentType = params.contentType || 'application/octet-stream';
  // Retry a failed sidecar after an acknowledged creation without recreating its body.
  const creation = params.createOnly ? { bodyStored: false } : undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (backend === 'fake-r2') {
        return await putFakeR2(
          params.rootAgentId,
          params.objectPath,
          params.ciphertext,
          params.metadata,
          params.createOnly,
          creation
        );
      }
      if (backend === 'r2' || (isProduction() && backend !== 'local')) {
        return await putR2(
          params.rootAgentId,
          params.objectPath,
          params.ciphertext,
          contentType,
          params.metadata,
          params.createOnly,
          creation
        );
      }
      return await putLocal(
        params.rootAgentId,
        params.objectPath,
        params.ciphertext,
        params.metadata,
        params.createOnly,
        creation
      );
    } catch (error) {
      if (params.createOnly && isExistingObjectError(error)) return null;
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.warn('Trace archive store failed', {
        root_agent_id: params.rootAgentId,
        object_path: params.objectPath,
        attempt,
        attempts: STORE_MAX_ATTEMPTS,
        error: errorMessage,
      });
      if (attempt < STORE_MAX_ATTEMPTS) {
        if (backend === 'r2' || (isProduction() && backend !== 'local')) {
          if (shouldResetS3ClientAfterError(errorMessage)) resetS3Client();
        }
        await sleep(retryDelayMs(attempt));
      }
    }
  }
  if (params.createOnly) throw lastError;
  return null;
}

export async function storePlainArtifact(params: {
  rootAgentId: string;
  objectPath: string;
  body: Buffer;
  contentType: string;
  createOnly?: boolean;
}): Promise<string | null> {
  if (!archiveEnabled()) return null;
  requireBoundRoot(params.rootAgentId);
  const backend = (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase();
  if (backend === 'r2' || (isProduction() && backend !== 'local' && backend !== 'fake-r2')) {
    assertR2ArchiveWriteAllowed();
  }
  const objectPath = safeArchivePath(params.objectPath);
  let lastError: unknown;
  for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (backend === 'fake-r2') {
        return await putFakeR2(
          params.rootAgentId,
          objectPath,
          params.body,
          undefined,
          params.createOnly
        );
      }
      if (backend === 'r2' || (isProduction() && backend !== 'local')) {
        return await putR2(
          params.rootAgentId,
          objectPath,
          params.body,
          params.contentType,
          undefined,
          params.createOnly
        );
      }
      return await putLocal(
        params.rootAgentId,
        objectPath,
        params.body,
        undefined,
        params.createOnly
      );
    } catch (error) {
      if (params.createOnly && isExistingObjectError(error)) return null;
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.warn('Trace public archive store failed', {
        root_agent_id: params.rootAgentId,
        object_path: objectPath,
        attempt,
        attempts: STORE_MAX_ATTEMPTS,
        error: errorMessage,
      });
      if (attempt < STORE_MAX_ATTEMPTS) {
        if (backend === 'r2' || (isProduction() && backend !== 'local')) {
          if (shouldResetS3ClientAfterError(errorMessage)) resetS3Client();
        }
        await sleep(retryDelayMs(attempt));
      }
    }
  }
  if (params.createOnly) throw lastError;
  return null;
}

export async function readArchivedArtifact(params: {
  rootAgentId: string;
  objectPath: string;
}): Promise<StoredEncryptedArtifact | null> {
  if (!archiveEnabled()) return null;
  const backend = (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase();
  const objectPath = safeArchivePath(params.objectPath);
  if (backend === 'r2' || (isProduction() && backend !== 'local')) {
    return readR2Object(params.rootAgentId, objectPath);
  }
  return readLocalObject(params.rootAgentId, objectPath);
}

/** Preserve R2 transport failures for callers that must distinguish an outage from a missing object. */
export async function readArchivedArtifactStrict(params: {
  rootAgentId: string;
  objectPath: string;
}): Promise<StoredEncryptedArtifact | null> {
  if (!archiveEnabled()) throw new Error('Trace archive is disabled');
  const backend = (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase();
  const objectPath = safeArchivePath(params.objectPath);
  if (backend === 'r2' || (isProduction() && backend !== 'local')) {
    return readR2ObjectStrict(params.rootAgentId, objectPath);
  }
  return readLocalObject(params.rootAgentId, objectPath);
}

export function decryptAndValidateArtifact(params: {
  ciphertext: Buffer;
  metadata: EncryptedArtifactMetadata;
}): Buffer {
  return decryptAndValidateArtifactEnvelope({
    ...params,
    encryptionKey: encryptionKey(),
  });
}

export async function archiveBytes(params: {
  rootAgentId: string;
  objectPath: string;
  body: Buffer;
  contentType: string;
  compress?: boolean;
  createOnly?: boolean;
}): Promise<StoreResult | null> {
  if (!archiveEnabled()) return null;
  const encrypted = encryptArtifact(
    params.objectPath,
    params.body,
    params.contentType,
    params.compress,
    { deterministic: params.createOnly === true }
  );
  if (encrypted === null) return null;
  const ref = await storeEncryptedArtifact({
    rootAgentId: params.rootAgentId,
    objectPath: encrypted.metadata.path,
    ciphertext: encrypted.ciphertext,
    metadata: encrypted.metadata,
    createOnly: params.createOnly,
  });
  if (ref !== null) await reconcileLateArtifact(params.rootAgentId, encrypted.metadata.path);
  return ref === null ? null : { ref, metadata: encrypted.metadata };
}

export async function archiveJson(params: {
  rootAgentId: string;
  objectPath: string;
  value: unknown;
  createOnly?: boolean;
}): Promise<StoreResult | null> {
  const value = params.objectPath.startsWith('provider/email/gmail/')
    ? redactGmailArchive(params.value)
    : params.value;
  return archiveBytes({
    rootAgentId: params.rootAgentId,
    objectPath: params.objectPath,
    body: Buffer.from(JSON.stringify(value, jsonReplacer)),
    contentType: 'application/json',
    compress: true,
    createOnly: params.createOnly,
  });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export async function listArchivedObjects(
  rootAgentId: string,
  options?: { throwOnError?: boolean }
): Promise<ArchivedObjectSummary[]> {
  if (!archiveEnabled()) return [];
  const backend = (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase();
  try {
    if (backend === 'fake-r2') {
      return listLocalObjects(rootAgentId).map((item) => ({
        ...item,
        ref: fakeR2Ref(rootAgentId, item.path),
      }));
    }
    if (backend === 'r2' || (isProduction() && backend !== 'local')) {
      return await listR2Objects(rootAgentId);
    }
    return listLocalObjects(rootAgentId);
  } catch (error) {
    log.warn('Trace archive list failed', {
      root_agent_id: rootAgentId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (options?.throwOnError === true) {
      throw error instanceof Error
        ? error
        : new Error(`Trace archive list failed: ${String(error)}`);
    }
    return [];
  }
}

/** List a bundle and surface every storage failure to the caller. */
export async function listArchivedObjectsStrict(
  rootAgentId: string
): Promise<ArchivedObjectSummary[]> {
  return listArchivedObjects(rootAgentId, { throwOnError: true });
}

export async function deleteArchivedBundle(
  rootAgentId: string,
  request: ArchiveDeletionRequest
): Promise<ArchiveBundleDeleteResult> {
  assertUserRequestedDeletion(request);
  log.warn('Trace archive bundle deletion on explicit user request', {
    root_agent_id: rootAgentId,
    requested_by: request.requestedBy,
    reason: request.reason.slice(0, 200),
  });
  if (!archiveEnabled()) {
    return { rootAgentId, backend: storageBackend(), deletedObjectCount: 0 };
  }
  const backend = storageBackend();
  if (backend === 'r2' || (isProduction() && backend !== 'local')) {
    return deleteR2Bundle(rootAgentId);
  }
  return deleteLocalBundle(rootAgentId);
}

function storageBackend(): string {
  return (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase() || 'local';
}

function listLocalObjects(rootAgentId: string): ArchivedObjectSummary[] {
  return listLocalArchivedObjects({
    localArchiveRoot: localArchiveRoot(),
    objectPrefix: objectPrefix(rootAgentId),
  });
}

async function putFakeR2(
  rootAgentId: string,
  objectPath: string,
  body: Buffer,
  metadata?: unknown,
  createOnly = false,
  creation?: ArtifactCreation
): Promise<string> {
  await putLocal(rootAgentId, objectPath, body, metadata, createOnly, creation);
  return fakeR2Ref(rootAgentId, objectPath);
}

function fakeR2Ref(rootAgentId: string, objectPath: string): string {
  return `r2://fake-trace-archive/${objectKey(rootAgentId, objectPath)}`;
}

async function listR2Objects(rootAgentId: string): Promise<ArchivedObjectSummary[]> {
  const bucket = process.env.R2_BUCKET_TRACE_ARCHIVE || '';
  if (bucket === '') return [];
  return listR2ArchivedObjects({
    bucket,
    objectPrefix: objectPrefix(rootAgentId),
    client: getS3Client(),
  });
}

async function deleteR2Bundle(rootAgentId: string): Promise<ArchiveBundleDeleteResult> {
  assertR2ArchiveWriteAllowed('delete from');
  const bucket = process.env.R2_BUCKET_TRACE_ARCHIVE || '';
  return deleteR2ArchivedBundle({
    rootAgentId,
    bucket,
    objectPrefix: objectPrefix(rootAgentId),
    client: getS3Client(),
  });
}

function deleteLocalBundle(rootAgentId: string): ArchiveBundleDeleteResult {
  return deleteLocalArchivedBundle({
    rootAgentId,
    backend: storageBackend(),
    localArchiveRoot: localArchiveRoot(),
    objectPrefix: objectPrefix(rootAgentId),
  });
}
