import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { streamToBuffer } from './traceArchiveBody';
import path from 'node:path';
import { localObjectPath, objectKey } from './traceArchivePaths';
import { withTraceArchiveRequestTimeout } from './traceArchiveRequest';

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
  if (!creation?.bodyStored) {
    writeLocalFile(target, body, createOnly, metadata !== undefined);
    if (creation) creation.bodyStored = true;
  }
  if (metadata !== undefined) {
    writeLocalFile(`${target}.meta.json`, JSON.stringify(metadata, null, 2), createOnly, true);
  }
  return target;
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
