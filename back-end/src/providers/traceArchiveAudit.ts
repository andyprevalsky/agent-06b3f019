import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger';
import {
  archiveEnabled,
  decryptAndValidateArtifact,
  listArchivedObjects,
  readArchivedArtifact,
  validateEncryptedArtifactEnvelope,
} from './traceArchive';

const log = createLogger('TraceArchiveAudit');

export interface ArchiveBundleAuditResult {
  rootAgentId: string;
  ok: boolean;
  backend: string;
  objectCount: number;
  encryptedObjectCount: number;
  decryptedObjectCount: number;
  requiredObjects: Record<string, boolean>;
  missing: string[];
  invalid: { path: string; error: string }[];
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.ENVIRONMENT === 'production';
}

function localArchiveRoot(): string {
  return process.env.TRACE_ARCHIVE_LOCAL_DIR || path.resolve(process.cwd(), '..', '.context');
}

function storageBackend(): string {
  return (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase() || 'local';
}

function shouldUseR2(): boolean {
  const backend = storageBackend();
  return backend === 'r2' || (isProduction() && backend !== 'local');
}

function getS3Client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID || ''}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
}

export async function listArchiveBundleIds(): Promise<string[]> {
  if (!archiveEnabled()) return [];
  try {
    return shouldUseR2() ? await listR2BundleIds() : listLocalBundleIds();
  } catch (error) {
    log.warn('Trace archive bundle list failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

export async function auditArchiveBundle(rootAgentId: string): Promise<ArchiveBundleAuditResult> {
  const objects = await listArchivedObjects(rootAgentId);
  const paths = new Set(objects.map((object) => object.path));
  const requiredPaths = [
    'db/start.fixture.json.gz.enc',
    'db/end.fixture.json.gz.enc',
    'manifest.json.gz.enc',
    'manifest.public.json',
  ];
  const requiredObjects = Object.fromEntries(
    requiredPaths.map((requiredPath) => [requiredPath, paths.has(requiredPath)])
  );
  const missing = requiredPaths.filter((requiredPath) => !paths.has(requiredPath));
  const encryptedObjects = objects.filter((object) => object.path.endsWith('.enc'));
  const invalid: { path: string; error: string }[] = [];
  let decryptedObjectCount = 0;
  for (const object of encryptedObjects) {
    try {
      const stored = await readArchivedArtifact({ rootAgentId, objectPath: object.path });
      if (stored === null) throw new Error('encrypted object is not readable');
      validateEncryptedArtifactEnvelope({
        objectPath: object.path,
        ciphertext: stored.ciphertext,
        metadata: stored.metadata,
      });
      decryptAndValidateArtifact(stored);
      decryptedObjectCount += 1;
    } catch (error) {
      invalid.push({
        path: object.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    rootAgentId,
    ok: missing.length === 0 && invalid.length === 0,
    backend: storageBackend(),
    objectCount: objects.length,
    encryptedObjectCount: encryptedObjects.length,
    decryptedObjectCount,
    requiredObjects,
    missing,
    invalid,
  };
}

function listLocalBundleIds(): string[] {
  const root = path.join(localArchiveRoot(), 'trace-archive');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

async function listR2BundleIds(): Promise<string[]> {
  const bucket = process.env.R2_BUCKET_TRACE_ARCHIVE || '';
  if (bucket === '') return [];
  const client = getS3Client();
  const ids = new Set<string>();
  let continuationToken: string | undefined;
  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: 'trace-archive/',
        Delimiter: '/',
        ContinuationToken: continuationToken,
      })
    );
    for (const prefix of response.CommonPrefixes ?? []) {
      const value = prefix.Prefix;
      if (value === undefined) continue;
      const id = value.slice('trace-archive/'.length).replace(/\/$/, '');
      if (id !== '') ids.add(id);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);
  return [...ids].sort();
}
