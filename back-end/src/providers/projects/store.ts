/**
 * Project persistence (Prisma). Owner scoping is enforced here: every lookup
 * takes the caller's userId, and a foreign project is indistinguishable from a
 * missing one.
 *
 * 10k-agent behaviour: rows are keyed per project; a session start reads one
 * project + its env files (bounded by MAX_ENV_FILES) + one snapshot row. No
 * shared row, counter or channel is touched by more than one user.
 */
import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../database';
import { normalizeGithubUrl } from '../github';
import { findGrantedRepoUrls } from '../githubRepos/store';

/** Projects expose their connected repo's canonical ref (GitHub repo integration). */
export { canonicalGithubRepoRef } from '../githubRepos/refs';
import { randomBytes } from '../crypto';
import { decryptProjectBinary, decryptProjectSecret } from './secrets';
import { redactableSecretValues, type EnvVariableMeta } from './envFile';
import type {
  ProjectEnvFileKind,
  ProjectEnvFileSource,
  ProjectSyncManifest,
  ProjectTemplateSnapshot,
  ProjectWorkspace,
} from './types';

export const PROJECT_LIST_LIMIT = 200;
export const MAX_ENV_FILES = 200;

export interface ProjectFolderRecord {
  id: string;
  name: string;
  projectId: string;
  sortOrder: number;
}

export const folderOrderBy = [
  { sortOrder: 'asc' as const },
  { name: 'asc' as const },
  { id: 'asc' as const },
];

const folderSelection = {
  select: { id: true, name: true, projectId: true, sortOrder: true },
  orderBy: folderOrderBy,
};

export interface ProjectRecord {
  folders?: ProjectFolderRecord[];
  id: string;
  userId: string;
  name: string;
  repoUrl: string | null;
  defaultBranch: string;
  startupScript: string | null;
  startupTimeoutS: number;
  autoWake: boolean;
  /** Default code-sandbox size `{cpu, memoryGb}` (C16); null = deployment default. */
  sandboxSize: unknown;
  maintenanceScript: string | null;
  maintenanceTimeoutS: number;
  maintenanceNightly: boolean;
  maintenanceOnGithubChange: boolean;
  maintenanceWatchedSha: string | null;
  maintenanceWatchCheckedAt: Date | null;
  maintenanceRunId: string | null;
  maintenanceLeaseUntil: Date | null;
  templateSnapshotId: string | null;
  templateSnapshotAt: Date | null;
  templateSnapshotSha: string | null;
  templateSnapshotSize: unknown;
  syncSalt: string;
  syncRevision: number;
  lastSyncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectEnvFileRecord {
  id: string;
  projectId: string;
  path: string;
  description: string | null;
  kind: string;
  source: string;
  variables: Prisma.JsonValue;
  encryptedContent: string | null;
  fingerprint: string | null;
  linkTarget: string | null;
  sizeBytes: number;
  createdAt: Date;
  updatedAt: Date;
}

export function newSyncSalt(): string {
  return randomBytes(16).toString('hex');
}

export async function userExists(userId: string): Promise<boolean> {
  return (await prisma.user.count({ where: { userId } })) > 0;
}

export type ProjectWithCount = ProjectRecord & { _count: { envFiles: number } };

/** One query: projects + env-file counts (no N+1). */
export async function listProjects(userId: string): Promise<ProjectWithCount[]> {
  return prisma.project.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
    take: PROJECT_LIST_LIMIT,
    include: { _count: { select: { envFiles: true } }, folders: folderSelection },
  });
}

/**
 * Repo URLs (as stored on projects) Rose has verified clone access to for this
 * user: a GithubRepoAccess grant exists for the normalized URL. One indexed
 * query for any number of projects.
 */
export async function findGithubConnectedRepoUrls(
  userId: string,
  repoUrls: (string | null)[]
): Promise<Set<string>> {
  const normalized = new Map<string, string[]>();
  for (const raw of repoUrls) {
    if (!raw) continue;
    const url = normalizeGithubUrl(raw);
    if (url) normalized.set(url, [...(normalized.get(url) ?? []), raw]);
  }
  if (normalized.size === 0) return new Set();
  const granted = await findGrantedRepoUrls(userId, [...normalized.keys()]);
  return new Set([...granted].flatMap((url) => normalized.get(url) ?? []));
}

export async function findProject(userId: string, id: string): Promise<ProjectRecord | null> {
  return prisma.project.findFirst({ where: { id, userId }, include: { folders: folderSelection } });
}

export async function countEnvFiles(projectId: string): Promise<number> {
  return prisma.projectEnvFile.count({ where: { projectId } });
}

/** Project restored into a code session (null when the session has none). */
/** An ACTIVE session's sandbox id (E2B id, `local-…` or `mac-…`), or null. */
export async function findActiveSessionSandboxId(sessionId: string): Promise<string | null> {
  const session = await prisma.claudeCodeSession.findUnique({
    where: { id: sessionId },
    select: { sandboxId: true, status: true },
  });
  return session?.status === 'ACTIVE' ? session.sandboxId : null;
}

export async function findSessionProject(
  sessionId: string
): Promise<{ projectId: string; userId: string } | null> {
  const session = await prisma.claudeCodeSession.findUnique({
    where: { id: sessionId },
    select: { projectId: true },
  });
  if (!session?.projectId) return null;
  const project = await prisma.project.findUnique({
    where: { id: session.projectId },
    select: { id: true, userId: true },
  });
  return project ? { projectId: project.id, userId: project.userId } : null;
}

export async function findProjectByName(
  userId: string,
  name: string
): Promise<ProjectRecord | null> {
  return prisma.project.findUnique({
    where: { userId_name: { userId, name } },
    include: { folders: folderSelection },
  });
}

export async function createProject(
  data: Omit<Prisma.ProjectUncheckedCreateInput, 'syncSalt'>
): Promise<ProjectRecord> {
  return prisma.project.create({
    data: { ...data, syncSalt: newSyncSalt() },
    include: { folders: folderSelection },
  });
}

/** Column value for a project's default sandbox size; null clears it (SQL NULL, C16). */
export function sandboxSizeColumn(
  size: { cpu?: number; memoryGb?: number } | null
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return size === null ? Prisma.DbNull : size;
}

export class ProjectRepositoryBusyError extends Error {}

export async function updateProject(
  id: string,
  data: Prisma.ProjectUncheckedUpdateInput
): Promise<ProjectRecord> {
  if (data.repoUrl === undefined) {
    return prisma.project.update({ where: { id }, data, include: { folders: folderSelection } });
  }
  return runTransactionWithRetry(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${id} FOR UPDATE`;
    const current = await tx.project.findUniqueOrThrow({ where: { id } });
    if (data.repoUrl === current.repoUrl) {
      return tx.project.update({ where: { id }, data, include: { folders: folderSelection } });
    }
    if (current.maintenanceRunId !== null) throw new ProjectRepositoryBusyError();
    return tx.project.update({
      where: { id },
      data: {
        ...data,
        syncRevision: { increment: 1 },
        // Retain both IDs for the existing publication cleanup, but make the
        // current snapshot unusable immediately for this different repository.
        templateSnapshotAt: null,
        templateSnapshotSha: null,
        templateSnapshotRunId: null,
        templateSnapshotSize: Prisma.DbNull,
        maintenanceWatchedSha: null,
        maintenanceWatchCheckedAt: null,
      },
      include: { folders: folderSelection },
    });
  });
}

/** Works with both immediate db-push FKs and deferred migration FKs. */
export async function deleteProject(id: string): Promise<void> {
  await runTransactionWithRetry(async (tx) => {
    // Match folder writes' lock order before touching agents or cascading folders.
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${id} FOR UPDATE`;
    await tx.agent.updateMany({
      where: { projectId: id, folderId: { not: null } },
      data: { folderId: null },
    });
    await tx.project.delete({ where: { id } });
  });
}

export async function listEnvFiles(projectId: string): Promise<ProjectEnvFileRecord[]> {
  return prisma.projectEnvFile.findMany({
    where: { projectId },
    orderBy: { path: 'asc' },
    take: MAX_ENV_FILES,
  });
}

export async function findEnvFile(
  projectId: string,
  path: string
): Promise<ProjectEnvFileRecord | null> {
  return prisma.projectEnvFile.findUnique({ where: { projectId_path: { projectId, path } } });
}

export async function findEnvFileById(
  projectId: string,
  id: string
): Promise<ProjectEnvFileRecord | null> {
  return prisma.projectEnvFile.findFirst({ where: { id, projectId } });
}

export interface EnvFileWrite {
  path: string;
  description?: string | null;
  kind: ProjectEnvFileKind;
  source: ProjectEnvFileSource;
  variables: EnvVariableMeta[];
  encryptedContent: string | null;
  fingerprint: string | null;
  linkTarget?: string | null;
  sizeBytes: number;
}

export async function upsertEnvFile(
  projectId: string,
  write: EnvFileWrite,
  client: Prisma.TransactionClient = prisma
): Promise<ProjectEnvFileRecord> {
  const data = {
    description: write.description ?? null,
    kind: write.kind,
    source: write.source,
    variables: write.variables as unknown as Prisma.InputJsonValue,
    encryptedContent: write.encryptedContent,
    fingerprint: write.fingerprint,
    linkTarget: write.linkTarget ?? null,
    sizeBytes: write.sizeBytes,
  };
  return client.projectEnvFile.upsert({
    where: { projectId_path: { projectId, path: write.path } },
    create: { projectId, path: write.path, ...data },
    update: data,
  });
}

export async function deleteEnvFile(id: string): Promise<void> {
  await prisma.projectEnvFile.delete({ where: { id } });
}

export async function deleteEnvFilesByPath(
  projectId: string,
  paths: string[],
  client: Prisma.TransactionClient = prisma
): Promise<void> {
  if (paths.length === 0) return;
  await client.projectEnvFile.deleteMany({ where: { projectId, path: { in: paths } } });
}

export async function findSyncSnapshot(projectId: string) {
  return prisma.projectSyncSnapshot.findUnique({ where: { projectId } });
}

/**
 * Claim the next sync revision. Optimistic: returns null when another push
 * already advanced the project past `baseRevision`.
 */
export async function claimSyncRevision(
  projectId: string,
  baseRevision: number,
  extra: { repoUrl?: string } = {},
  expectedRepoUrl?: string | null,
  client: Prisma.TransactionClient = prisma
): Promise<number | null> {
  const claimed = await client.project.updateMany({
    where: {
      id: projectId,
      syncRevision: baseRevision,
      ...(expectedRepoUrl !== undefined ? { repoUrl: expectedRepoUrl } : {}),
    },
    data: { syncRevision: baseRevision + 1, lastSyncedAt: new Date(), ...extra },
  });
  return claimed.count === 1 ? baseRevision + 1 : null;
}

export async function writeSyncSnapshot(
  projectId: string,
  revision: number,
  data: {
    manifest: ProjectSyncManifest;
    encryptedGitBundle: string | null;
    gitBundleFingerprint: string | null;
    encryptedUncommittedPatch: string | null;
    patchFingerprint: string | null;
  },
  client: Prisma.TransactionClient = prisma
): Promise<void> {
  const row = {
    revision,
    manifest: data.manifest as unknown as Prisma.InputJsonValue,
    encryptedGitBundle: data.encryptedGitBundle,
    gitBundleFingerprint: data.gitBundleFingerprint,
    encryptedUncommittedPatch: data.encryptedUncommittedPatch,
    patchFingerprint: data.patchFingerprint,
  };
  await client.projectSyncSnapshot.upsert({
    where: { projectId },
    create: { projectId, ...row },
    update: row,
  });
}

/** Commit a planned sync only while its original repository/revision still owns the row. */
export async function commitSyncPush(
  projectId: string,
  baseRevision: number,
  expectedRepoUrl: string | null,
  extra: { repoUrl?: string },
  writes: EnvFileWrite[],
  pruned: string[],
  snapshot: Parameters<typeof writeSyncSnapshot>[2]
): Promise<number | null> {
  return runTransactionWithRetry(async (tx) => {
    const revision = await claimSyncRevision(projectId, baseRevision, extra, expectedRepoUrl, tx);
    if (revision === null) return null;
    for (const write of writes) await upsertEnvFile(projectId, write, tx);
    await deleteEnvFilesByPath(projectId, pruned, tx);
    await writeSyncSnapshot(projectId, revision, snapshot, tx);
    return revision;
  });
}

export class ProjectWorkspaceError extends Error {}

/** The project's published template snapshot as a session start needs it, or null. */
export function templateSnapshotOf(project: {
  templateSnapshotId: string | null;
  templateSnapshotAt: Date | null;
  templateSnapshotSize: unknown;
}): ProjectTemplateSnapshot | null {
  if (project.templateSnapshotId === null || project.templateSnapshotAt === null) return null;
  const { cpu, memoryGb } = (project.templateSnapshotSize ?? {}) as {
    cpu?: unknown;
    memoryGb?: unknown;
  };
  return {
    id: project.templateSnapshotId,
    size:
      Number.isInteger(cpu) && Number.isInteger(memoryGb)
        ? { cpu: cpu as number, memoryGb: memoryGb as number }
        : null,
  };
}

/** Same GitHub SSH aliases accepted by onboarding; local paths remain case-sensitive. */
export function projectRepositoryKey(value: string): string {
  const trimmed = value.trim();
  const github =
    /^(?:(?:https?:\/\/)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed
    );
  return github
    ? `https://github.com/${github[1]}/${github[2]}`.toLowerCase()
    : trimmed.replace(/\/$/, '');
}

/** A synced checkout is reusable only for the repository recorded by its manifest. */
export function syncSnapshotMatchesRepo(
  repoUrl: string | null,
  manifest: ProjectSyncManifest | null
): boolean {
  const remote = manifest?.git?.remoteUrl;
  if (repoUrl === null) return remote === null;
  if (typeof remote !== 'string') return false;
  return projectRepositoryKey(repoUrl) === projectRepositoryKey(remote);
}

/**
 * Decrypt everything a code session needs for one project. Throws on any
 * undecryptable envelope rather than materializing a partial checkout.
 */
export async function prepareProjectWorkspace(
  userId: string,
  projectId: string
): Promise<ProjectWorkspace> {
  const project = await findProject(userId, projectId);
  if (!project) throw new ProjectWorkspaceError('Project not found');
  const [envFiles, snapshot] = await Promise.all([
    listEnvFiles(project.id),
    findSyncSnapshot(project.id),
  ]);
  // Keep stale encrypted data stored, but never restore it into a different repository.
  const boundSnapshot = syncSnapshotMatchesRepo(
    project.repoUrl,
    (snapshot?.manifest as unknown as ProjectSyncManifest | undefined) ?? null
  )
    ? snapshot
    : null;
  const files: ProjectWorkspace['files'] = [];
  const redactions: string[] = [];
  for (const file of envFiles) {
    if (file.encryptedContent === null) continue; // declared, awaiting sync
    const content = decryptProjectSecret(file.encryptedContent);
    if (content === null) {
      throw new ProjectWorkspaceError(`Env file ${file.path} could not be decrypted`);
    }
    files.push({
      path: file.path,
      kind: file.kind === 'config' ? 'config' : 'env',
      content: Buffer.from(content, 'utf8'),
      linkTarget: file.linkTarget,
    });
    redactions.push(...redactableSecretValues(content));
  }
  const decryptOptional = (envelope: string | null | undefined, label: string) => {
    if (!envelope) return null;
    const out = decryptProjectBinary(envelope);
    if (out === null) throw new ProjectWorkspaceError(`${label} could not be decrypted`);
    return out;
  };
  return {
    project: {
      id: project.id,
      name: project.name,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      startupScript: project.startupScript,
      startupTimeoutS: project.startupTimeoutS,
      sandboxSize: project.sandboxSize ?? null,
      templateSnapshot: templateSnapshotOf(project),
    },
    revision: project.syncRevision,
    manifest: (boundSnapshot?.manifest as unknown as ProjectSyncManifest | undefined) ?? null,
    files,
    gitBundle: decryptOptional(boundSnapshot?.encryptedGitBundle, 'Git bundle'),
    uncommittedPatch: decryptOptional(
      boundSnapshot?.encryptedUncommittedPatch,
      'Uncommitted patch'
    ),
    redactions,
  };
}
