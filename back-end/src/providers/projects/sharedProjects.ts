/**
 * Projects a teammate may run because their owner shared them with a team
 * (TeamProjectShare), under the validity rules of domains/teams/serviceAccess.ts
 * listSharedProjects: the caller is an ACCEPTED member of the sharing team, the
 * sharer still is one, and the project still belongs to the sharer.
 *
 *   github_repo_ref=<shared project id> ─► placement (domains/agents/agentProject.ts)
 *                                       └► code session (session.ts) restores:
 *        the owner's repo checkout, default branch, startup script, setup manifest,
 *        and for a project without a remote its synced bundle + uncommitted patch.
 *        Never restored for a teammate: the owner's env files and linked config
 *        files, the owner's template snapshot (it can hold them), the owner's
 *        GitHub credential; the clone uses the teammate's own access.
 *
 * 10k-agent behaviour: one indexed query per lookup (TeamProjectShare by
 * projectId, membership by (userId, status)); nothing scans a team.
 */
import { prisma } from '../database';
import { decryptProjectBinary } from './secrets';
import { findSyncSnapshot, ProjectWorkspaceError, syncSnapshotMatchesRepo } from './store';
import type { ProjectSyncManifest, ProjectWorkspace } from './types';

export interface SharedProjectRecord {
  id: string;
  /** The owner (sharer). */
  userId: string;
  name: string;
  repoUrl: string | null;
  defaultBranch: string;
  startupScript: string | null;
  startupTimeoutS: number;
  sandboxSize: unknown;
  syncRevision: number;
}

const projectSelect = {
  id: true,
  userId: true,
  name: true,
  repoUrl: true,
  defaultBranch: true,
  startupScript: true,
  startupTimeoutS: true,
  sandboxSize: true,
  syncRevision: true,
} as const;

/** Of `projectIds`, the projects other users validly share with `userId`. */
export async function findSharedProjects(
  userId: string,
  projectIds: string[]
): Promise<SharedProjectRecord[]> {
  if (projectIds.length === 0) return [];
  const rows = await prisma.teamProjectShare.findMany({
    where: {
      projectId: { in: [...new Set(projectIds)] },
      ownerUserId: { not: userId },
      member: { status: 'ACCEPTED' },
      team: { members: { some: { userId, status: 'ACCEPTED' } } },
    },
    select: { ownerUserId: true, project: { select: projectSelect } },
  });
  const byId = new Map<string, SharedProjectRecord>();
  for (const row of rows) {
    if (row.project.userId === row.ownerUserId) byId.set(row.project.id, row.project);
  }
  return [...byId.values()];
}

export async function findSharedProject(
  userId: string,
  projectId: string
): Promise<SharedProjectRecord | null> {
  return (await findSharedProjects(userId, [projectId]))[0] ?? null;
}

function decrypted(envelope: string | null | undefined, label: string): Buffer | null {
  if (!envelope) return null;
  const out = decryptProjectBinary(envelope);
  if (out === null) throw new ProjectWorkspaceError(`${label} could not be decrypted`);
  return out;
}

/**
 * A shared project's workspace for a teammate (null: not shared with them):
 * no env files, no template snapshot, no clone credential (the caller resolves
 * the teammate's own).
 */
export async function prepareSharedProjectWorkspace(
  userId: string,
  projectId: string
): Promise<ProjectWorkspace | null> {
  const project = await findSharedProject(userId, projectId);
  if (project === null) return null;
  const snapshot = await findSyncSnapshot(project.id);
  const manifest = (snapshot?.manifest as unknown as ProjectSyncManifest | undefined) ?? null;
  const bound = snapshot !== null && syncSnapshotMatchesRepo(project.repoUrl, manifest);
  // The synced checkout is the code only for a project without a remote.
  const codeSnapshot = bound && project.repoUrl === null ? snapshot : null;
  return {
    project: {
      id: project.id,
      name: project.name,
      repoUrl: project.repoUrl,
      defaultBranch: project.defaultBranch,
      startupScript: project.startupScript,
      startupTimeoutS: project.startupTimeoutS,
      sandboxSize: project.sandboxSize ?? null,
      templateSnapshot: null,
    },
    revision: project.syncRevision,
    manifest: bound ? manifest : null,
    files: [],
    gitBundle: decrypted(codeSnapshot?.encryptedGitBundle, 'Git bundle'),
    uncommittedPatch: decrypted(codeSnapshot?.encryptedUncommittedPatch, 'Uncommitted patch'),
    redactions: [],
  };
}
