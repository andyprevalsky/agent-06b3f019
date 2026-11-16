/**
 * Connected GitHub repos (Prisma). Shared by the integrations panel API, the
 * projects (folders) API, agent creation and code-session launch, so the
 * connection lifecycle lives in one place:
 *
 *   connect ─► Integration{name: github_repo, accountId: ref, CONNECTED}
 *              + GithubRepoConnection{canonicalRef, repo details, connectedRoseProjectRef}
 *   disconnect ─► connection row deleted, Integration kept as NOT_CONNECTED
 *                 (tombstone: the legacy project import never re-adds it)
 *   project deleted ─► the same for every connection linked to it
 *
 * Clone permission is still the GithubRepoAccess grant (checkGithubRepoAccess);
 * a connection is what makes a granted repo part of the user's inventory and
 * resolvable by canonical ref.
 *
 * 10k-agent behaviour: every query is keyed by one user (indexed unique
 * (userId, canonicalRef) / (userId, name, accountId)); lists are bounded by
 * GITHUB_REPO_LIST_LIMIT; agent creation pays at most two indexed reads.
 */
import { IntegrationStatus, IntegrationType, type Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../database';
import { createLogger } from '../logger';
import {
  GITHUB_REPO_INTEGRATION_NAME,
  githubRepoIdentity,
  sameGithubRepo,
  type GithubRepoIdentity,
} from './refs';

export const GITHUB_REPO_LIST_LIMIT = 200;

const log = createLogger('GithubRepoStore');

export type GithubRepoConnectionSource = 'connect' | 'legacy_project';

export interface GithubRepoConnectionRecord {
  id: string;
  userId: string;
  integrationId: string;
  canonicalRef: string;
  repoUrl: string;
  owner: string;
  repoName: string;
  defaultBranch: string;
  connectedRoseProjectRef: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Idempotent GithubRepoAccess grant (the one implementation; skip duplicates). */
export async function grantGithubRepoAccess(userId: string, repoUrl: string): Promise<void> {
  await prisma.githubRepoAccess.createMany({ data: [{ userId, repoUrl }], skipDuplicates: true });
}

/** Normalized repo URLs among `normalizedUrls` the user holds a GithubRepoAccess grant for. */
export async function findGrantedRepoUrls(
  userId: string,
  normalizedUrls: string[]
): Promise<Set<string>> {
  if (normalizedUrls.length === 0) return new Set();
  const grants = await prisma.githubRepoAccess.findMany({
    where: { userId, repoUrl: { in: [...new Set(normalizedUrls)] } },
    select: { repoUrl: true },
  });
  return new Set(grants.map((grant) => grant.repoUrl));
}

export interface ConnectGithubRepoWrite {
  userId: string;
  identity: GithubRepoIdentity;
  defaultBranch: string;
  connectedRoseProjectRef: string | null;
  source: GithubRepoConnectionSource;
}

function integrationConfig(write: ConnectGithubRepoWrite): Prisma.InputJsonObject {
  return {
    canonical_ref: write.identity.canonicalRef,
    repo_url: write.identity.repoUrl,
    repo_name: write.identity.repoName,
    owner: write.identity.owner,
    default_branch: write.defaultBranch,
    connected_rose_project_ref: write.connectedRoseProjectRef,
  };
}

async function writeConnection(
  tx: Prisma.TransactionClient,
  write: ConnectGithubRepoWrite
): Promise<GithubRepoConnectionRecord> {
  const { userId, identity } = write;
  const integration = await tx.integration.upsert({
    where: {
      userId_name_accountId: {
        userId,
        name: GITHUB_REPO_INTEGRATION_NAME,
        accountId: identity.canonicalRef,
      },
    },
    create: {
      userId,
      name: GITHUB_REPO_INTEGRATION_NAME,
      accountId: identity.canonicalRef,
      type: IntegrationType.TOOL_SETUP,
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      config: integrationConfig(write),
    },
    update: {
      status: IntegrationStatus.CONNECTED,
      isActive: true,
      failureReason: null,
      config: integrationConfig(write),
    },
  });
  return tx.githubRepoConnection.upsert({
    where: { userId_canonicalRef: { userId, canonicalRef: identity.canonicalRef } },
    create: {
      userId,
      integrationId: integration.id,
      canonicalRef: identity.canonicalRef,
      repoUrl: identity.repoUrl,
      owner: identity.owner,
      repoName: identity.repoName,
      defaultBranch: write.defaultBranch,
      connectedRoseProjectRef: write.connectedRoseProjectRef,
      source: write.source,
    },
    update: {
      integrationId: integration.id,
      repoUrl: identity.repoUrl,
      owner: identity.owner,
      repoName: identity.repoName,
      defaultBranch: write.defaultBranch,
      // Reconnecting without a project keeps the project it was connected through.
      ...(write.connectedRoseProjectRef !== null
        ? { connectedRoseProjectRef: write.connectedRoseProjectRef }
        : {}),
    },
  });
}

/** Create or refresh one connection and its Integration row together. */
export async function connectGithubRepo(
  write: ConnectGithubRepoWrite
): Promise<GithubRepoConnectionRecord> {
  return runTransactionWithRetry((tx) => writeConnection(tx, write));
}

/** Remove the connection; the Integration row stays as a NOT_CONNECTED tombstone. */
export async function disconnectGithubRepo(userId: string, canonicalRef: string): Promise<boolean> {
  return runTransactionWithRetry(async (tx) => {
    const deleted = await tx.githubRepoConnection.deleteMany({ where: { userId, canonicalRef } });
    await tx.integration.updateMany({
      where: { userId, name: GITHUB_REPO_INTEGRATION_NAME, accountId: canonicalRef },
      data: { status: IntegrationStatus.NOT_CONNECTED, isActive: false },
    });
    return deleted.count > 0;
  });
}

/**
 * Inside a project's delete transaction: disconnect every repo connected
 * through it (a connected repo is a project; its connection would otherwise
 * outlive it unlinked and get a new project on the next list).
 */
export async function disconnectProjectRepos(
  tx: Prisma.TransactionClient,
  projectId: string
): Promise<number> {
  const linked = await tx.githubRepoConnection.findMany({
    where: { connectedRoseProjectRef: projectId },
    select: { id: true, integrationId: true },
  });
  if (linked.length === 0) return 0;
  await tx.githubRepoConnection.deleteMany({
    where: { id: { in: linked.map((row) => row.id) } },
  });
  await tx.integration.updateMany({
    where: { id: { in: linked.map((row) => row.integrationId) } },
    data: { status: IntegrationStatus.NOT_CONNECTED, isActive: false },
  });
  log.info('GitHub repos disconnected with their deleted project', {
    projectId,
    connectionIds: linked.map((row) => row.id).join(','),
  });
  return linked.length;
}

export async function listGithubRepoConnections(
  userId: string
): Promise<GithubRepoConnectionRecord[]> {
  return prisma.githubRepoConnection.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: GITHUB_REPO_LIST_LIMIT,
  });
}

export async function findGithubRepoConnection(
  userId: string,
  canonicalRef: string
): Promise<GithubRepoConnectionRecord | null> {
  return prisma.githubRepoConnection.findUnique({
    where: { userId_canonicalRef: { userId, canonicalRef } },
  });
}

/** Owner-scoped project (folder) fields the repo connection reads. */
export async function findOwnedProjectRepo(userId: string, projectId: string) {
  return prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true, repoUrl: true, defaultBranch: true },
  });
}

/**
 * Point a repo-less project at the repo connected through it, so its code
 * sessions restore that checkout (legacy project path). Never overwrites a repo.
 */
export async function setProjectRepoUrlIfEmpty(
  userId: string,
  projectId: string,
  repoUrl: string
): Promise<void> {
  await prisma.project.updateMany({
    where: { id: projectId, userId, repoUrl: null },
    data: { repoUrl },
  });
}

/**
 * Re-point a folder (project) at another repo in one transaction (connect with
 * `replace`): a different folder the repo was connected through lets go of it
 * (its repoUrl cleared when it still names the repo); this folder's other
 * connections stay connected but unassociated; the repo's connection is
 * written for this folder; the folder's repoUrl becomes the repo.
 */
export async function repointProjectRepo(
  write: ConnectGithubRepoWrite & { connectedRoseProjectRef: string }
): Promise<GithubRepoConnectionRecord> {
  const { userId, identity, connectedRoseProjectRef: projectId } = write;
  return runTransactionWithRetry(async (tx) => {
    const current = await tx.githubRepoConnection.findUnique({
      where: { userId_canonicalRef: { userId, canonicalRef: identity.canonicalRef } },
      select: { connectedRoseProjectRef: true },
    });
    const otherFolderId = current?.connectedRoseProjectRef ?? null;
    if (otherFolderId !== null && otherFolderId !== projectId) {
      const other = await tx.project.findFirst({
        where: { id: otherFolderId, userId },
        select: { repoUrl: true },
      });
      if (
        other !== null &&
        other.repoUrl !== null &&
        sameGithubRepo(other.repoUrl, identity.repoUrl)
      ) {
        await tx.project.updateMany({
          where: { id: otherFolderId, userId },
          data: { repoUrl: null },
        });
      }
    }
    await tx.githubRepoConnection.updateMany({
      where: {
        userId,
        connectedRoseProjectRef: projectId,
        canonicalRef: { not: identity.canonicalRef },
      },
      data: { connectedRoseProjectRef: null },
    });
    const connection = await writeConnection(tx, write);
    await tx.project.updateMany({
      where: { id: projectId, userId },
      data: { repoUrl: identity.repoUrl },
    });
    return connection;
  });
}

interface LegacyCandidate {
  identity: GithubRepoIdentity;
  projectId: string;
  defaultBranch: string;
}

/** Oldest project per repo (projects arrive createdAt-ascending), as in the migration. */
function legacyCandidates(
  projects: { id: string; repoUrl: string | null; defaultBranch: string }[]
): LegacyCandidate[] {
  const byRef = new Map<string, LegacyCandidate>();
  for (const project of projects) {
    const identity = githubRepoIdentity(project.repoUrl);
    if (identity === null || byRef.has(identity.canonicalRef)) continue;
    byRef.set(identity.canonicalRef, {
      identity,
      projectId: project.id,
      defaultBranch: project.defaultBranch,
    });
  }
  return [...byRef.values()];
}

/**
 * Runtime twin of the migration's legacy-project import (idempotent): every
 * repo a project carries that the user holds a grant for and never
 * disconnected becomes a connection. Steady state: three indexed reads.
 * `projectIds` narrows it to those projects (agent creation).
 */
export async function importLegacyProjectConnections(
  userId: string,
  projectIds?: string[]
): Promise<number> {
  const projects = await prisma.project.findMany({
    where: {
      userId,
      repoUrl: { not: null },
      ...(projectIds !== undefined ? { id: { in: projectIds } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: GITHUB_REPO_LIST_LIMIT,
    select: { id: true, repoUrl: true, defaultBranch: true },
  });
  const candidates = legacyCandidates(projects);
  if (candidates.length === 0) return 0;
  const [granted, existing] = await Promise.all([
    findGrantedRepoUrls(
      userId,
      candidates.map((candidate) => candidate.identity.repoUrl)
    ),
    prisma.integration.findMany({
      where: {
        userId,
        name: GITHUB_REPO_INTEGRATION_NAME,
        accountId: { in: candidates.map((candidate) => candidate.identity.canonicalRef) },
      },
      select: { accountId: true },
    }),
  ]);
  const known = new Set(existing.map((row) => row.accountId));
  const missing = candidates.filter(
    (candidate) =>
      granted.has(candidate.identity.repoUrl) && !known.has(candidate.identity.canonicalRef)
  );
  for (const candidate of missing) {
    await runTransactionWithRetry(async (tx) => {
      // Re-check inside the write: a disconnect or connect that raced this import wins.
      const row = await tx.integration.findUnique({
        where: {
          userId_name_accountId: {
            userId,
            name: GITHUB_REPO_INTEGRATION_NAME,
            accountId: candidate.identity.canonicalRef,
          },
        },
        select: { id: true },
      });
      if (row !== null) return;
      await writeConnection(tx, {
        userId,
        identity: candidate.identity,
        defaultBranch: candidate.defaultBranch,
        connectedRoseProjectRef: candidate.projectId,
        source: 'legacy_project',
      });
    });
  }
  return missing.length;
}

/** Canonical refs among `refs` the user has an active connection for. */
export async function findConnectedRefs(userId: string, refs: string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const rows = await prisma.githubRepoConnection.findMany({
    where: { userId, canonicalRef: { in: [...new Set(refs)] } },
    select: { canonicalRef: true },
  });
  return new Set(rows.map((row) => row.canonicalRef));
}
