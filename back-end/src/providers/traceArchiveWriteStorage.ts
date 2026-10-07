import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import path from 'node:path';
import { localObjectPath, objectKey } from './traceArchivePaths';
import { withTraceArchiveRequestTimeout } from './traceArchiveRequest';

export type ArtifactCreation = { bodyStored: boolean };

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
    fs.writeFileSync(target, body, { flag: createOnly ? 'wx' : 'w' });
    if (creation) creation.bodyStored = true;
  }
  if (metadata !== undefined) {
    fs.writeFileSync(`${target}.meta.json`, JSON.stringify(metadata, null, 2), {
      flag: createOnly ? 'wx' : 'w',
    });
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
    if (creation) creation.bodyStored = true;
  }
  if (metadata !== undefined) {
    await withTraceArchiveRequestTimeout((abortSignal) =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${key}.meta.json`,
          Body: Buffer.from(JSON.stringify(metadata, null, 2)),
          ContentType: 'application/json',
          ServerSideEncryption: 'AES256',
          ...(createOnly ? { IfNoneMatch: '*' } : {}),
        }),
        { abortSignal }
      )
    );
  }
  return `r2://${bucket}/${key}`;
}
