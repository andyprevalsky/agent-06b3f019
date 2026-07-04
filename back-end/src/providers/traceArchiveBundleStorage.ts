import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveBundleDeleteResult, ArchivedObjectSummary } from './traceArchive';

export function listLocalArchivedObjects(params: {
  localArchiveRoot: string;
  objectPrefix: string;
}): ArchivedObjectSummary[] {
  const dir = path.join(params.localArchiveRoot, params.objectPrefix);
  if (!fs.existsSync(dir)) return [];
  const results: ArchivedObjectSummary[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.name.endsWith('.meta.json')) continue;
      const relative = path.relative(dir, full).split(path.sep).join('/');
      let metadata: unknown;
      const metaPath = `${full}.meta.json`;
      if (fs.existsSync(metaPath)) {
        try {
          metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch {
          metadata = undefined;
        }
      }
      results.push({ ref: full, path: relative, metadata });
    }
  };
  walk(dir);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export async function listR2ArchivedObjects(params: {
  bucket: string;
  objectPrefix: string;
  client: S3Client;
}): Promise<ArchivedObjectSummary[]> {
  const results: ArchivedObjectSummary[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await params.client.send(
      new ListObjectsV2Command({
        Bucket: params.bucket,
        Prefix: params.objectPrefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const item of response.Contents ?? []) {
      if (item.Key === undefined || item.Key.endsWith('.meta.json')) continue;
      results.push({
        ref: `r2://${params.bucket}/${item.Key}`,
        path: item.Key.slice(params.objectPrefix.length),
      });
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function listR2ObjectKeys(params: {
  bucket: string;
  objectPrefix: string;
  client: S3Client;
}): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await params.client.send(
      new ListObjectsV2Command({
        Bucket: params.bucket,
        Prefix: params.objectPrefix,
        ContinuationToken: continuationToken,
      })
    );
    for (const item of response.Contents ?? []) {
      if (item.Key !== undefined) keys.push(item.Key);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken !== undefined);
  return keys.sort();
}

export async function deleteR2ArchivedBundle(params: {
  rootAgentId: string;
  bucket: string;
  objectPrefix: string;
  client: S3Client;
}): Promise<ArchiveBundleDeleteResult> {
  if (params.bucket === '')
    return { rootAgentId: params.rootAgentId, backend: 'r2', deletedObjectCount: 0 };
  const keys = await listR2ObjectKeys(params);
  for (let index = 0; index < keys.length; index += 1000) {
    const chunk = keys.slice(index, index + 1000);
    if (chunk.length === 0) continue;
    await params.client.send(
      new DeleteObjectsCommand({
        Bucket: params.bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    );
  }
  return { rootAgentId: params.rootAgentId, backend: 'r2', deletedObjectCount: keys.length };
}

export function deleteLocalArchivedBundle(params: {
  rootAgentId: string;
  backend: string;
  localArchiveRoot: string;
  objectPrefix: string;
}): ArchiveBundleDeleteResult {
  const dir = path.join(params.localArchiveRoot, params.objectPrefix);
  if (!fs.existsSync(dir)) {
    return { rootAgentId: params.rootAgentId, backend: params.backend, deletedObjectCount: 0 };
  }
  let deletedObjectCount = 0;
  const countFiles = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        countFiles(full);
      } else {
        deletedObjectCount += 1;
      }
    }
  };
  countFiles(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return { rootAgentId: params.rootAgentId, backend: params.backend, deletedObjectCount };
}
