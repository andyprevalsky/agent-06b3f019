import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { streamToBuffer } from './traceArchiveBody';
import path from 'node:path';
import { localObjectPath, objectKey } from './traceArchivePaths';
import { withTraceArchiveRequestTimeout } from './traceArchiveRequest';
import { assertR2ArchiveWriteAllowed } from './traceArchiveR2Guard';

export type ArtifactCreation = { bodyStored: boolean };

export function isExistingObjectError(error: unknown): boolean {
  const response = error as {
    code?: string;
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    response?.code === 'EEXIST' ||
    response?.name === 'PreconditionFailed' ||
    response?.$metadata?.httpStatusCode === 412
  );
}

function writeLocalFile(
  target: string,
  body: Buffer | string,
  createOnly: boolean,
  resumeMatching: boolean
): void {
  if (!createOnly) {
    fs.writeFileSync(target, body);
    return;
  }
  const expected = typeof body === 'string' ? Buffer.from(body) : body;
  // Staging is hidden from the ordinary archive listing's metadata filter.
  const temporary = path.join(path.dirname(target), `.trace-write-${randomUUID()}.meta.json`);
  try {
    fs.writeFileSync(temporary, body, { flag: 'wx' });
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (
        !isExistingObjectError(error) ||
        !resumeMatching ||
        !fs.readFileSync(target).equals(expected)
      )
        throw error;
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function putR2File(params: {
  client: S3Client;
  bucket: string;
  key: string;
  body: Buffer;
  contentType: string;
  createOnly: boolean;
  resumeMatching: boolean;
}): Promise<void> {
  const { client, bucket, key, body, contentType, createOnly, resumeMatching } = params;
  try {
    await withTraceArchiveRequestTimeout((abortSignal) =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: 'AES256',
          ...(createOnly ? { IfNoneMatch: '*' } : {}),
        }),
        { abortSignal }
      )
    );
  } catch (error) {
    if (!createOnly || !resumeMatching || !isExistingObjectError(error)) throw error;
    const existing = await withTraceArchiveRequestTimeout(async (abortSignal) => {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
        abortSignal,
      });
      return streamToBuffer(response.Body, abortSignal);
    });
    if (!existing.equals(body)) throw error;
  }
}

export async function putLocal(
  rootAgentId: string,
  objectPath: string,
  body: Buffer,
  metadata?: unknown,
  createOnly = false,
  creation?: ArtifactCreation
): Promise<string> {
  const target = localObjectPath(rootAgentId, objectPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (createOnly && metadata !== undefined) {
    await storeCreateOnlyPair(localPairStore(), target, body, metadata, creation);
    return target;
  }
  if (!creation?.bodyStored) {
    writeLocalFile(target, body, createOnly, metadata !== undefined);
    if (creation) creation.bodyStored = true;
  }
  if (metadata !== undefined) {
    writeLocalFile(`${target}.meta.json`, JSON.stringify(metadata, null, 2), createOnly, true);
  }
  return target;
}

/** Minimal storage surface for create-only body + sidecar publication. */
interface PairStore {
  read(key: string): Promise<Buffer | null>;
  /** False when the key already exists. */
  create(key: string, body: Buffer | string): Promise<boolean>;
  overwrite(key: string, body: Buffer): Promise<void>;
}

function existingObjectError(key: string): Error {
  const error = new Error(`Archive object already exists: ${key}`) as Error & { code: string };
  error.code = 'EEXIST';
  return error;
}

function sidecarCiphertextSha(sidecar: Buffer): string | null {
  try {
    const parsed = JSON.parse(sidecar.toString('utf8')) as { ciphertext_sha256?: unknown };
    return typeof parsed.ciphertext_sha256 === 'string' ? parsed.ciphertext_sha256 : null;
  } catch {
    return null;
  }
}

/**
 * Create-only body + `.meta.json` publication that a retry can always complete.
 *
 *   body new                         → create body, create sidecar
 *   body identical, sidecar missing  → complete the sidecar (prior attempt died between writes)
 *   body differs, sidecar missing    → the old body is undecryptable (its nonce lived only in the
 *                                      lost sidecar): claim the sidecar first, then replace the body
 *   sidecar names OUR ciphertext     → torn pair from our earlier claim: replace the body
 *   anything else                    → a different complete artifact exists (EEXIST, never overwritten)
 */
async function storeCreateOnlyPair(
  store: PairStore,
  key: string,
  body: Buffer,
  metadata: unknown,
  creation?: ArtifactCreation
): Promise<void> {
  const sidecarKey = `${key}.meta.json`;
  const sidecarBody = JSON.stringify(metadata, null, 2);
  const ours = createHash('sha256').update(body).digest('hex');
  // A retry inside the same store call may find its own sidecar already landed.
  const resumingOwnWrite = creation?.bodyStored === true;
  if (!resumingOwnWrite && !(await store.create(key, body))) {
    const existing = await store.read(key);
    if (existing === null || !existing.equals(body)) {
      const sidecar = await store.read(sidecarKey);
      if (sidecar === null) {
        if (!(await store.create(sidecarKey, sidecarBody))) throw existingObjectError(key);
        await store.overwrite(key, body);
        if (creation) creation.bodyStored = true;
        return;
      }
      if (sidecarCiphertextSha(sidecar) !== ours) throw existingObjectError(key);
      await store.overwrite(key, body);
      if (creation) creation.bodyStored = true;
      return;
    }
  }
  if (creation) creation.bodyStored = true;
  if (!(await store.create(sidecarKey, sidecarBody))) {
    // An identical COMPLETE artifact from another call stays an existing-object no-op.
    const sidecar = await store.read(sidecarKey);
    if (!resumingOwnWrite || sidecar === null || sidecarCiphertextSha(sidecar) !== ours) {
      throw existingObjectError(sidecarKey);
    }
  }
}

function localPairStore(): PairStore {
  return {
    async read(key) {
      try {
        return fs.readFileSync(key);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async create(key, body) {
      try {
        writeLocalFile(key, body, true, false);
        return true;
      } catch (error) {
        if (isExistingObjectError(error)) return false;
        throw error;
      }
    },
    async overwrite(key, body) {
      const temporary = path.join(path.dirname(key), `.trace-write-${randomUUID()}.meta.json`);
      try {
        fs.writeFileSync(temporary, body, { flag: 'wx' });
        fs.renameSync(temporary, key);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
  };
}

function r2PairStore(client: S3Client, bucket: string, contentType: string): PairStore {
  const put = (key: string, body: Buffer | string, createOnly: boolean) =>
    withTraceArchiveRequestTimeout((abortSignal) =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: key.endsWith('.meta.json') ? 'application/json' : contentType,
          ServerSideEncryption: 'AES256',
          ...(createOnly ? { IfNoneMatch: '*' } : {}),
        }),
        { abortSignal }
      )
    );
  return {
    async read(key) {
      try {
        return await withTraceArchiveRequestTimeout(async (abortSignal) => {
          const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
            abortSignal,
          });
          return streamToBuffer(response.Body, abortSignal);
        });
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if ((error as { name?: string }).name === 'NoSuchKey' || status === 404) return null;
        throw error;
      }
    },
    async create(key, body) {
      try {
        await put(key, body, true);
        return true;
      } catch (error) {
        if (isExistingObjectError(error)) return false;
        throw error;
      }
    },
    async overwrite(key, body) {
      await put(key, body, false);
    },
  };
}

let s3Client: S3Client | null = null;

export function getS3Client(): S3Client {
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

export function resetS3Client(): void {
  s3Client?.destroy();
  s3Client = null;
}

export function shouldResetS3ClientAfterError(errorMessage: string): boolean {
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

export async function putR2(
  rootAgentId: string,
  objectPath: string,
  body: Buffer,
  contentType: string,
  metadata?: unknown,
  createOnly = false,
  creation?: ArtifactCreation
): Promise<string> {
  assertR2ArchiveWriteAllowed();
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
  if (createOnly && metadata !== undefined) {
    await storeCreateOnlyPair(
      r2PairStore(client, bucket, contentType),
      key,
      body,
      metadata,
      creation
    );
    return `r2://${bucket}/${key}`;
  }
  if (!creation?.bodyStored) {
    await putR2File({
      client,
      bucket,
      key,
      body,
      contentType,
      createOnly,
      resumeMatching: metadata !== undefined,
    });
    if (creation) creation.bodyStored = true;
  }
  if (metadata !== undefined) {
    await putR2File({
      client,
      bucket,
      key: `${key}.meta.json`,
      body: Buffer.from(JSON.stringify(metadata, null, 2)),
      contentType: 'application/json',
      createOnly,
      resumeMatching: true,
    });
  }
  return `r2://${bucket}/${key}`;
}
