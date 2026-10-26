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
import { prisma } from '../database';
import { normalizeGithubUrl } from '../github';
import { randomBytes } from '../crypto';
import { decryptProjectBinary, decryptProjectSecret } from './secrets';
import { redactableSecretValues, type EnvVariableMeta } from './envFile';
import type {
  ProjectEnvFileKind,
  ProjectEnvFileSource,
  ProjectSyncManifest,
  ProjectWorkspace,
} from './types';

export const PROJECT_LIST_LIMIT = 200;
export const MAX_ENV_FILES = 200;

export interface ProjectRecord {
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
    include: { _count: { select: { envFiles: true } } },
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
  const grants = await prisma.githubRepoAccess.findMany({
    where: { userId, repoUrl: { in: [...normalized.keys()] } },
    select: { repoUrl: true },
  });
  return new Set(grants.flatMap((grant) => normalized.get(grant.repoUrl) ?? []));
}

export async function findProject(userId: string, id: string): Promise<ProjectRecord | null> {
  return prisma.project.findFirst({ where: { id, userId } });
}

export async function countEnvFiles(projectId: string): Promise<number> {
  return prisma.projectEnvFile.count({ where: { projectId } });
}

/** Project restored into a code session (null when the session has none). */
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
  return prisma.project.findUnique({ where: { userId_name: { userId, name } } });
}

export async function createProject(
  data: Omit<Prisma.ProjectUncheckedCreateInput, 'syncSalt'>
): Promise<ProjectRecord> {
  return prisma.project.create({ data: { ...data, syncSalt: newSyncSalt() } });
}

/** Column value for a project's default sandbox size; null clears it (SQL NULL, C16). */
export function sandboxSizeColumn(
  size: { cpu?: number; memoryGb?: number } | null
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return size === null ? Prisma.DbNull : size;
}

export async function updateProject(
  id: string,
  data: Prisma.ProjectUncheckedUpdateInput
): Promise<ProjectRecord> {
  return prisma.project.update({ where: { id }, data });
}

export async function deleteProject(id: string): Promise<void> {
  await prisma.project.delete({ where: { id } });
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
  write: EnvFileWrite
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
  return prisma.projectEnvFile.upsert({
    where: { projectId_path: { projectId, path: write.path } },
    create: { projectId, path: write.path, ...data },
    update: data,
  });
}

export async function deleteEnvFile(id: string): Promise<void> {
  await prisma.projectEnvFile.delete({ where: { id } });
}

export async function deleteEnvFilesByPath(projectId: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await prisma.projectEnvFile.deleteMany({ where: { projectId, path: { in: paths } } });
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
  extra: { repoUrl?: string } = {}
): Promise<number | null> {
  const claimed = await prisma.project.updateMany({
    where: { id: projectId, syncRevision: baseRevision },
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
  }
): Promise<void> {
  const row = {
    revision,
    manifest: data.manifest as unknown as Prisma.InputJsonValue,
    encryptedGitBundle: data.encryptedGitBundle,
    gitBundleFingerprint: data.gitBundleFingerprint,
    encryptedUncommittedPatch: data.encryptedUncommittedPatch,
    patchFingerprint: data.patchFingerprint,
  };
  await prisma.projectSyncSnapshot.upsert({
    where: { projectId },
    create: { projectId, ...row },
    update: row,
  });
}

export class ProjectWorkspaceError extends Error {}

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
    },
    revision: project.syncRevision,
    manifest: (snapshot?.manifest as unknown as ProjectSyncManifest | undefined) ?? null,
    files,
    gitBundle: decryptOptional(snapshot?.encryptedGitBundle, 'Git bundle'),
    uncommittedPatch: decryptOptional(snapshot?.encryptedUncommittedPatch, 'Uncommitted patch'),
    redactions,
  };
}
