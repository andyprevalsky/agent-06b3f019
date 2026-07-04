import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
import {
  decryptAndValidateArtifact as decryptAndValidateArtifactEnvelope,
  metadataFromUnknown,
  validateEncryptedArtifactEnvelope as validateEncryptedEnvelope,
} from './traceArchiveEnvelope';
import { createLogger } from './logger';

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

function isProduction(): boolean {
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

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96) || 'unbound';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeArchivePath(input: string): string {
  return input
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .map(safeSegment)
    .join('/');
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

export function encryptArtifact(
  objectPath: string,
  plaintext: Buffer,
  contentType: string,
  compress?: boolean
): { ciphertext: Buffer; metadata: EncryptedArtifactMetadata } | null {
  const key = encryptionKey();
  if (key === null) return null;

  const normalizedPath = safeArchivePath(objectPath);
  const useGzip = shouldCompress(normalizedPath, contentType, compress);
  const storedPlaintext = useGzip ? zlib.gzipSync(plaintext, { level: 6 }) : plaintext;
  const nonce = crypto.randomBytes(12);
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

function localArchiveRoot(): string {
  return process.env.TRACE_ARCHIVE_LOCAL_DIR || path.resolve(process.cwd(), '..', '.context');
}

function objectKey(rootAgentId: string, objectPath: string): string {
  return `trace-archive/${safeSegment(rootAgentId)}/${safeArchivePath(objectPath)}`;
}

function objectPrefix(rootAgentId: string): string {
  return `trace-archive/${safeSegment(rootAgentId)}/`;
}

function localObjectPath(rootAgentId: string, objectPath: string): string {
  return path.join(localArchiveRoot(), objectKey(rootAgentId, objectPath));
}

async function putLocal(
  rootAgentId: string,
  objectPath: string,
  body: Buffer,
  metadata?: unknown
): Promise<string> {
  const target = localObjectPath(rootAgentId, objectPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  if (metadata !== undefined) {
    fs.writeFileSync(`${target}.meta.json`, JSON.stringify(metadata, null, 2));
  }
  return target;
}

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (s3Client !== null) return s3Client;
  const accountId = process.env.R2_ACCOUNT_ID || '';
  s3Client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
  return s3Client;
}

function resetS3Client(): void {
  s3Client?.destroy();
  s3Client = null;
}

function shouldResetS3ClientAfterError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return (
    normalized.includes('bad record mac') ||
    normalized.includes('socket') ||
    normalized.includes('tls') ||
    normalized.includes('econnreset') ||
    normalized.includes('etimedout') ||
    normalized.includes('timeout') ||
    normalized.includes('network') ||
    normalized.includes('connection')
  );
}

function retryDelayMs(attempt: number): number {
  return 250 * attempt * attempt;
}

async function putR2(
  rootAgentId: string,
  objectPath: string,
  body: Buffer,
  contentType: string,
  metadata?: unknown
): Promise<string> {
  const bucket = process.env.R2_BUCKET_TRACE_ARCHIVE || '';
  if (
    bucket === '' ||
    !process.env.R2_ACCOUNT_ID ||
    !process.env.R2_ACCESS_KEY_ID ||
    !process.env.R2_SECRET_ACCESS_KEY
  ) {
    throw new Error('R2 trace archive is not configured');
  }
  const key = objectKey(rootAgentId, objectPath);
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ServerSideEncryption: 'AES256',
    })
  );
  if (metadata !== undefined) {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${key}.meta.json`,
        Body: Buffer.from(JSON.stringify(metadata, null, 2)),
        ContentType: 'application/json',
        ServerSideEncryption: 'AES256',
      })
    );
  }
  return `r2://${bucket}/${key}`;
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

function readLocalObject(rootAgentId: string, objectPath: string): StoredEncryptedArtifact | null {
  const target = localObjectPath(rootAgentId, objectPath);
  if (!fs.existsSync(target)) return null;
  const metadataPath = `${target}.meta.json`;
  if (!fs.existsSync(metadataPath)) throw new Error(`Archive metadata missing for ${objectPath}`);
  return {
    ciphertext: fs.readFileSync(target),
    metadata: metadataFromUnknown(JSON.parse(fs.readFileSync(metadataPath, 'utf8'))),
  };
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const maybeTransform = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
    transformToString?: () => Promise<string>;
  };
  if (typeof maybeTransform.transformToByteArray === 'function') {
    return Buffer.from(await maybeTransform.transformToByteArray());
  }
  if (typeof maybeTransform.transformToString === 'function') {
    return Buffer.from(await maybeTransform.transformToString());
  }
  const maybeAsyncIterable = body as AsyncIterable<Uint8Array>;
  if (typeof maybeAsyncIterable[Symbol.asyncIterator] === 'function') {
    const chunks: Buffer[] = [];
    for await (const chunk of maybeAsyncIterable) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  throw new Error('Unsupported archive response body');
}

async function getR2Object(bucket: string, key: string): Promise<Buffer> {
  const response = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return streamToBuffer(response.Body);
}

async function readR2Object(
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
}): Promise<string | null> {
  if (!archiveEnabled()) return null;
  const backend = (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase();
  const contentType = params.contentType || 'application/octet-stream';
  for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (backend === 'fake-r2') {
        return await putFakeR2(
          params.rootAgentId,
          params.objectPath,
          params.ciphertext,
          params.metadata
        );
      }
      if (backend === 'r2' || (isProduction() && backend !== 'local')) {
        return await putR2(
          params.rootAgentId,
          params.objectPath,
          params.ciphertext,
          contentType,
          params.metadata
        );
      }
      return await putLocal(
        params.rootAgentId,
        params.objectPath,
        params.ciphertext,
        params.metadata
      );
    } catch (error) {
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
  return null;
}

export async function storePlainArtifact(params: {
  rootAgentId: string;
  objectPath: string;
  body: Buffer;
  contentType: string;
}): Promise<string | null> {
  if (!archiveEnabled()) return null;
  const backend = (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase();
  const objectPath = safeArchivePath(params.objectPath);
  for (let attempt = 1; attempt <= STORE_MAX_ATTEMPTS; attempt += 1) {
    try {
      if (backend === 'fake-r2') {
        return await putFakeR2(params.rootAgentId, objectPath, params.body);
      }
      if (backend === 'r2' || (isProduction() && backend !== 'local')) {
        return await putR2(params.rootAgentId, objectPath, params.body, params.contentType);
      }
      return await putLocal(params.rootAgentId, objectPath, params.body);
    } catch (error) {
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
}): Promise<StoreResult | null> {
  if (!archiveEnabled()) return null;
  const encrypted = encryptArtifact(
    params.objectPath,
    params.body,
    params.contentType,
    params.compress
  );
  if (encrypted === null) return null;
  const ref = await storeEncryptedArtifact({
    rootAgentId: params.rootAgentId,
    objectPath: encrypted.metadata.path,
    ciphertext: encrypted.ciphertext,
    metadata: encrypted.metadata,
  });
  return ref === null ? null : { ref, metadata: encrypted.metadata };
}

export async function archiveJson(params: {
  rootAgentId: string;
  objectPath: string;
  value: unknown;
}): Promise<StoreResult | null> {
  return archiveBytes({
    rootAgentId: params.rootAgentId,
    objectPath: params.objectPath,
    body: Buffer.from(JSON.stringify(params.value, jsonReplacer)),
    contentType: 'application/json',
    compress: true,
  });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export async function listArchivedObjects(rootAgentId: string): Promise<ArchivedObjectSummary[]> {
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
    return [];
  }
}

export async function deleteArchivedBundle(
  rootAgentId: string
): Promise<ArchiveBundleDeleteResult> {
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
  metadata?: unknown
): Promise<string> {
  await putLocal(rootAgentId, objectPath, body, metadata);
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
