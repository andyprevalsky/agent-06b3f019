/**
 * Persistence for published rose_user_ui versions.
 *
 *   UserUiVersion row (Postgres)            object storage (immutable)
 *     id, userId, manifest, counts   ─►     user-ui/<userId>/<id>/<path>
 *   User.activeUiVersionId                  user-ui/<userId>/<id>/.rose-index.json
 *
 * Objects are written once and never overwritten; a version row is only created
 * after every object (and the index) is stored, so a partially uploaded bundle
 * is never visible. Bundle paths cannot start with "." (manifest.ts), so the
 * index can never collide with a user file.
 *
 * Storage backend: Supabase Storage (providers/storage.ts) by default; set
 * USER_UI_STORAGE_BACKEND=local (+ USER_UI_STORAGE_LOCAL_DIR) for hermetic tests
 * and offline dev.
 */
import crypto from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve, sep } from 'path';
import type { Prisma } from '@prisma/client';
import { prisma } from '../database';
import { createLogger } from '../logger';
import { getStorageObject, putStorageObject } from '../storage';
import { type UserUiBundleFile, type UserUiManifest, userUiContentType } from './manifest';

const log = createLogger('UserUiStore');
const INDEX_FILE = '.rose-index.json';
const UPLOAD_CONCURRENCY = 8;

export interface UserUiIndexEntry {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface UserUiVersionRecord {
  id: string;
  userId: string;
  manifest: UserUiManifest;
  fileCount: number;
  totalBytes: number;
  createdAt: Date;
}

function objectKey(userId: string, versionId: string, path: string): string {
  return `user-ui/${userId}/${versionId}/${path}`;
}

function useLocalBackend(): boolean {
  return (process.env.USER_UI_STORAGE_BACKEND ?? '').trim().toLowerCase() === 'local';
}

function localPath(key: string): string {
  const root = resolve(
    process.env.USER_UI_STORAGE_LOCAL_DIR || join(process.cwd(), '.context', 'user-ui-storage')
  );
  const full = resolve(root, key);
  if (!full.startsWith(root + sep)) throw new Error('user-ui storage key escapes root');
  return full;
}

async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (useLocalBackend()) {
    const full = localPath(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
    return;
  }
  await putStorageObject(key, body, contentType);
}

async function getObject(key: string): Promise<Buffer | null> {
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

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function toRecord(row: {
  id: string;
  userId: string;
  manifest: Prisma.JsonValue;
  fileCount: number;
  totalBytes: number;
  createdAt: Date;
}): UserUiVersionRecord {
  return { ...row, manifest: row.manifest as unknown as UserUiManifest };
}

export async function userExists(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { userId }, select: { userId: true } });
  return user !== null;
}

/** Store every file + index, then create the row (and optionally activate it). */
export async function createUserUiVersion(params: {
  userId: string;
  files: UserUiBundleFile[];
  manifest: UserUiManifest;
  totalBytes: number;
  activate: boolean;
}): Promise<UserUiVersionRecord> {
  const versionId = crypto.randomUUID();
  const index: UserUiIndexEntry[] = params.files.map((file) => ({
    path: file.path,
    size: file.content.length,
    sha256: crypto.createHash('sha256').update(file.content).digest('hex'),
    contentType: userUiContentType(file.path),
  }));
  await mapLimit(params.files, UPLOAD_CONCURRENCY, (file) =>
    putObject(
      objectKey(params.userId, versionId, file.path),
      file.content,
      userUiContentType(file.path)
    )
  );
  await putObject(
    objectKey(params.userId, versionId, INDEX_FILE),
    Buffer.from(JSON.stringify({ files: index })),
    'application/json'
  );

  const create = prisma.userUiVersion.create({
    data: {
      id: versionId,
      userId: params.userId,
      manifest: params.manifest as unknown as Prisma.InputJsonValue,
      fileCount: params.files.length,
      totalBytes: params.totalBytes,
    },
  });
  const [row] = params.activate
    ? await prisma.$transaction([
        create,
        prisma.user.update({
          where: { userId: params.userId },
          data: { activeUiVersionId: versionId },
        }),
      ])
    : [await create];
  log.info('Published user UI version', {
    userId: params.userId,
    versionId,
    fileCount: params.files.length,
    totalBytes: params.totalBytes,
    activated: params.activate,
  });
  return toRecord(row);
}

/** Point the user at one of THEIR versions; false when it is not theirs. */
export async function activateUserUiVersion(userId: string, versionId: string): Promise<boolean> {
  const version = await prisma.userUiVersion.findFirst({
    where: { id: versionId, userId },
    select: { id: true },
  });
  if (!version) return false;
  await prisma.user.update({ where: { userId }, data: { activeUiVersionId: versionId } });
  log.info('Activated user UI version', { userId, versionId });
  return true;
}

export async function findActiveUserUiVersion(userId: string): Promise<UserUiVersionRecord | null> {
  const user = await prisma.user.findUnique({
    where: { userId },
    select: { activeUiVersionId: true },
  });
  if (!user?.activeUiVersionId) return null;
  const row = await prisma.userUiVersion.findFirst({
    where: { id: user.activeUiVersionId, userId },
  });
  return row ? toRecord(row) : null;
}

export async function listUserUiVersions(userId: string, limit = 100) {
  const [user, rows] = await Promise.all([
    prisma.user.findUnique({ where: { userId }, select: { activeUiVersionId: true } }),
    prisma.userUiVersion.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
  ]);
  return { activeVersionId: user?.activeUiVersionId ?? null, versions: rows.map(toRecord) };
}

// versionId → userId is immutable, so cache it to keep asset reads off the DB.
const versionOwnerCache = new Map<string, string>();
const VERSION_OWNER_CACHE_MAX = 5000;

async function versionOwner(versionId: string): Promise<string | null> {
  const cached = versionOwnerCache.get(versionId);
  if (cached) return cached;
  const row = await prisma.userUiVersion.findUnique({
    where: { id: versionId },
    select: { userId: true },
  });
  if (!row) return null;
  if (versionOwnerCache.size >= VERSION_OWNER_CACHE_MAX) {
    const oldest = versionOwnerCache.keys().next().value;
    if (oldest !== undefined) versionOwnerCache.delete(oldest);
  }
  versionOwnerCache.set(versionId, row.userId);
  return row.userId;
}

/** Read one published file by (unguessable) version id; null when absent. */
export async function readUserUiFile(versionId: string, path: string): Promise<Buffer | null> {
  const owner = await versionOwner(versionId);
  if (!owner) return null;
  return getObject(objectKey(owner, versionId, path));
}

/** All files of a version (for restoring it into a code-agent workspace). */
export async function readUserUiVersionFiles(
  userId: string,
  versionId: string
): Promise<UserUiBundleFile[]> {
  const rawIndex = await getObject(objectKey(userId, versionId, INDEX_FILE));
  if (!rawIndex) throw new Error(`user UI version ${versionId} has no index`);
  const { files } = JSON.parse(rawIndex.toString('utf8')) as { files: UserUiIndexEntry[] };
  const out: UserUiBundleFile[] = [];
  await mapLimit(files, UPLOAD_CONCURRENCY, async (entry) => {
    const content = await getObject(objectKey(userId, versionId, entry.path));
    if (!content) throw new Error(`user UI version ${versionId} is missing ${entry.path}`);
    out.push({ path: entry.path, content });
  });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
