/**
 * Object store for code-session checkpoints.
 *
 * Keys: user/<userId>/code-sessions/<codeSessionId>/<seq>/<artifact>
 *       user/<userId>/code-sessions/<codeSessionId>/close/<taskId>.json (close result)
 * Prod uses Supabase Storage via providers/storage. Hermetic tests set
 * CODE_SESSION_STORAGE_BACKEND=local (+ CODE_SESSION_STORAGE_LOCAL_DIR).
 */
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import { deleteFromStorage, getStorageObject, putStorageObject } from '../storage';

function useLocalBackend(): boolean {
  return (process.env.CODE_SESSION_STORAGE_BACKEND ?? '').trim().toLowerCase() === 'local';
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;

export function checkpointKey(
  userId: string,
  codeSessionId: string,
  seq: number,
  artifact: string
): string {
  for (const segment of [userId, codeSessionId, artifact]) {
    if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new Error(`Unsafe code-session storage segment: ${JSON.stringify(segment)}`);
    }
  }
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`Invalid checkpoint seq ${seq}`);
  return `user/${userId}/code-sessions/${codeSessionId}/${seq}/${artifact}`;
}

/** One task's close result (handoff + output files), returned again on a retried close. */
export function closeRecordKey(userId: string, codeSessionId: string, taskId: string): string {
  for (const segment of [userId, codeSessionId, taskId]) {
    if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new Error(`Unsafe code-session storage segment: ${JSON.stringify(segment)}`);
    }
  }
  return `user/${userId}/code-sessions/${codeSessionId}/close/${taskId}.json`;
}

function localPath(key: string): string {
  const root = resolve(
    process.env.CODE_SESSION_STORAGE_LOCAL_DIR ||
      join(process.cwd(), '.context', 'code-session-storage')
  );
  const full = resolve(root, key);
  if (!full.startsWith(root + sep)) throw new Error('code-session storage key escapes root');
  return full;
}

export async function putCheckpointObject(key: string, body: Buffer): Promise<void> {
  if (useLocalBackend()) {
    const full = localPath(key);
    await mkdir(dirname(full), { recursive: true });
    // Same key, same bytes on a retry; never overwrite an existing artifact.
    await writeFile(full, body, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
    return;
  }
  await putStorageObject(key, body, 'application/octet-stream');
}

export async function getCheckpointObject(key: string): Promise<Buffer | null> {
  if (useLocalBackend()) {
    try {
      return await readFile(localPath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
  return getStorageObject(key);
}

export async function deleteCheckpointObject(key: string): Promise<void> {
  if (useLocalBackend()) {
    await rm(localPath(key), { force: true });
    return;
  }
  await deleteFromStorage(key);
}
