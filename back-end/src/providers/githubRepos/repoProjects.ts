/**
 * A connected GitHub repo IS a project: every connection belongs to one of its
 * owner's projects (GithubRepoConnection.connectedRoseProjectRef).
 *
 *   connect without a project ─┐
 *   connection with no project ─┴► the user's oldest project carrying the repo
 *                                  (canonical compare), else a new project named
 *                                  <repo>, or <owner>/<repo> when <repo> is taken
 *                                  (a repository only: isFolder false)
 *   project deleted ───────────► its connections are disconnected (projects store)
 *
 * Concurrency: the @@unique([userId, name]) create race re-reads the winner and
 * uses it when it carries the repo; a link is written only while the
 * connection is still unlinked, so concurrent connects and lists converge on
 * one project.
 *
 * 10k-agent behaviour: per user only. The list-time check is one indexed query
 * (the userId prefix of @@unique([userId, canonicalRef])) bounded by
 * GITHUB_REPO_LIST_LIMIT; projects are read and written only when a
 * connection has no project.
 */
import { prisma } from '../database';
import { createLogger } from '../logger';
import { newSyncSalt, PROJECT_LIST_LIMIT } from '../projects/store';
import { githubRepoIdentity, sameGithubRepo, type GithubRepoIdentity } from './refs';
import { GITHUB_REPO_LIST_LIMIT } from './store';

const log = createLogger('GithubRepoProjects');

interface RepoProjectRow {
  id: string;
  repoUrl: string | null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/** The user's projects that carry a repo, oldest first (bounded). */
function listRepoProjects(userId: string): Promise<RepoProjectRow[]> {
  return prisma.project.findMany({
    where: { userId, repoUrl: { not: null } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: PROJECT_LIST_LIMIT,
    select: { id: true, repoUrl: true },
  });
}

function findProjectByName(userId: string, name: string): Promise<RepoProjectRow | null> {
  return prisma.project.findUnique({
    where: { userId_name: { userId, name } },
    select: { id: true, repoUrl: true },
  });
}

/** Create the repo's project under the first free name; a racing creator of the repo wins. */
async function createRepoProject(
  userId: string,
  identity: GithubRepoIdentity,
  defaultBranch: string
): Promise<string | null> {
  for (const name of [identity.repoName, `${identity.owner}/${identity.repoName}`]) {
    if ((await findProjectByName(userId, name)) === null) {
      try {
        const created = await prisma.project.create({
          data: {
            userId,
            name,
            repoUrl: identity.repoUrl,
            // A repository in Integrations, never a left-bar folder.
            isFolder: false,
            defaultBranch,
            syncSalt: newSyncSalt(),
          },
          select: { id: true },
        });
        log.info('Project created for a connected GitHub repo', {
          userId,
          projectId: created.id,
          canonicalRef: identity.canonicalRef,
        });
        return created.id;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    // Taken: by this repo's project (a concurrent connect or list) or a different one.
    const holder = await findProjectByName(userId, name);
    if (holder !== null && sameGithubRepo(holder.repoUrl, identity.repoUrl)) return holder.id;
  }
  log.warn('No free project name for a connected GitHub repo', {
    userId,
    canonicalRef: identity.canonicalRef,
  });
  return null;
}

/**
 * The project a connection of `identity` belongs to: the user's oldest project
 * carrying the repo, else a new one. `projects` reuses an already-read list.
 */
export async function findOrCreateRepoProject(
  userId: string,
  identity: GithubRepoIdentity,
  defaultBranch: string,
  projects?: RepoProjectRow[]
): Promise<string | null> {
  const rows = projects ?? (await listRepoProjects(userId));
  const match = rows.find((row) => sameGithubRepo(row.repoUrl, identity.repoUrl));
  return match !== undefined ? match.id : createRepoProject(userId, identity, defaultBranch);
}

/**
 * Give every connection without a project its project (connected before repos
 * were projects, or let go by a folder that switched repos). Idempotent;
 * returns how many connections were linked by this call. Never throws: the
 * project list never depends on it, and the next list retries.
 */
export async function linkUnlinkedRepoConnections(userId: string): Promise<number> {
  try {
    return await linkUnlinked(userId);
  } catch (error) {
    log.error('Linking connected GitHub repos to projects failed', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

async function linkUnlinked(userId: string): Promise<number> {
  const unlinked = await prisma.githubRepoConnection.findMany({
    where: { userId, connectedRoseProjectRef: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: GITHUB_REPO_LIST_LIMIT,
    select: { id: true, repoUrl: true, defaultBranch: true },
  });
  if (unlinked.length === 0) return 0;
  const projects = await listRepoProjects(userId);
  let linked = 0;
  for (const connection of unlinked) {
    const identity = githubRepoIdentity(connection.repoUrl);
    if (identity === null) continue;
    const projectId = await findOrCreateRepoProject(
      userId,
      identity,
      connection.defaultBranch,
      projects
    );
    if (projectId === null) continue;
    const updated = await prisma.githubRepoConnection.updateMany({
      where: { id: connection.id, userId, connectedRoseProjectRef: null },
      data: { connectedRoseProjectRef: projectId },
    });
    if (updated.count > 0) {
      linked += updated.count;
      log.info('GitHub repo linked to its project', {
        userId,
        projectId,
        canonicalRef: identity.canonicalRef,
      });
    }
  }
  return linked;
}
