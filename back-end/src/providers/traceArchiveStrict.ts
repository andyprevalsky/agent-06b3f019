import { HeadObjectCommand } from '@aws-sdk/client-s3';
import fs from 'node:fs';
import {
  type StoredEncryptedArtifact,
  archiveEnabled,
  getR2Object,
  getS3Client,
  isMissingObjectError,
  isProduction,
  localObjectPath,
  objectKey,
  readLocalObject,
  readR2ObjectStrict,
  safeArchivePath,
} from './traceArchive';
import { withTraceArchiveRequestTimeout } from './traceArchiveRequest';

/** Read an encrypted artifact and surface storage/auth/metadata failures. */
export async function readArchivedArtifactStrict(params: {
  rootAgentId: string;
  objectPath: string;
}): Promise<StoredEncryptedArtifact | null> {
  if (!archiveEnabled()) return null;
  const backend = (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase();
  const objectPath = safeArchivePath(params.objectPath);
  if (backend === 'fake-r2') return readLocalObject(params.rootAgentId, objectPath);
  if (backend === 'r2' || (isProduction() && backend !== 'local')) {
    return readR2ObjectStrict(params.rootAgentId, objectPath);
  }
  return readLocalObject(params.rootAgentId, objectPath);
}

/** Check for a plain control object without swallowing storage failures. */
export async function plainArchiveArtifactExists(params: {
  rootAgentId: string;
  objectPath: string;
}): Promise<boolean> {
  if (!archiveEnabled()) return false;
  const backend = (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase();
  const objectPath = safeArchivePath(params.objectPath);
  if (backend === 'fake-r2') return fs.existsSync(localObjectPath(params.rootAgentId, objectPath));
  if (backend === 'r2' || (isProduction() && backend !== 'local')) {
    const bucket = process.env.R2_BUCKET_TRACE_ARCHIVE || '';
    if (bucket === '') throw new Error('R2 trace archive is not configured');
    try {
      await withTraceArchiveRequestTimeout((abortSignal) =>
        getS3Client().send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: objectKey(params.rootAgentId, objectPath),
          }),
          { abortSignal }
        )
      );
      return true;
    } catch (error) {
      if (isMissingObjectError(error)) return false;
      throw error;
    }
  }
  return fs.existsSync(localObjectPath(params.rootAgentId, objectPath));
}

/** Read a plain control object; only a true not-found is converted to null. */
export async function readPlainArchivedArtifact(params: {
  rootAgentId: string;
  objectPath: string;
}): Promise<Buffer | null> {
  if (!archiveEnabled()) return null;
  const backend = (process.env.TRACE_ARCHIVE_BACKEND || '').trim().toLowerCase();
  const objectPath = safeArchivePath(params.objectPath);
  if (backend === 'fake-r2') {
    const target = localObjectPath(params.rootAgentId, objectPath);
    return fs.existsSync(target) ? fs.readFileSync(target) : null;
  }
  if (backend === 'r2' || (isProduction() && backend !== 'local')) {
    const bucket = process.env.R2_BUCKET_TRACE_ARCHIVE || '';
    if (bucket === '') throw new Error('R2 trace archive is not configured');
    try {
      return await getR2Object(bucket, objectKey(params.rootAgentId, objectPath));
    } catch (error) {
      if (isMissingObjectError(error)) return null;
      throw error;
    }
  }
  const target = localObjectPath(params.rootAgentId, objectPath);
  return fs.existsSync(target) ? fs.readFileSync(target) : null;
}
