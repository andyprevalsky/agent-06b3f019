/**
 * Team-shared GitHub repos (docs/plans/active/share-all-integrations.md).
 *
 *   a ref the reader has no own connection for
 *     ─► resolveTeamDataAccess(reader): validated github_repo grants
 *        (accepted reader and owner, CONNECTED row, accountId = canonical ref)
 *     ─► the owner's GithubRepoConnection behind that exact Integration row
 *     ─► only while the owner still holds its GithubRepoAccess clone grant
 *
 * A shared connection is the repository only. It never carries the owner's
 * folder (connectedRoseProjectRef is null), so the owner's project restore,
 * environment files and startup script never reach a teammate's code session.
 * Clone and push still use Rose's own token; the code session checks clone
 * access against the owner (`connection.userId`).
 *
 * 10k agents: one grant query plus two indexed reads, bounded by the reader's grants.
 */
import { resolveTeamDataAccess } from '../teamAccess';
import { GITHUB_REPO_INTEGRATION_NAME } from './refs';
import {
  findGithubRepoConnectionsByOwner,
  findGrantedRepoPairs,
  type GithubRepoConnectionRecord,
} from './store';

export interface GithubRepoShare {
  teamId: string;
  teamName: string;
  ownerUserId: string;
  ownerName: string | null;
}

/** A connection the caller may use: their own (shared null) or a teammate's shared one. */
export interface UsableGithubRepoConnection extends GithubRepoConnectionRecord {
  shared: GithubRepoShare | null;
}

export function ownGithubRepoConnection(
  connection: GithubRepoConnectionRecord
): UsableGithubRepoConnection {
  return { ...connection, shared: null };
}

/** Repos teammates share with `userId` (one per canonical ref), optionally just `canonicalRef`. */
export async function sharedGithubRepoConnections(
  userId: string,
  canonicalRef?: string
): Promise<UsableGithubRepoConnection[]> {
  const grants = (await resolveTeamDataAccess(userId))
    .filter(
      (grant) =>
        grant.provider === GITHUB_REPO_INTEGRATION_NAME &&
        grant.ownerUserId !== userId &&
        (canonicalRef === undefined || grant.accountId === canonicalRef)
    )
    .sort((a, b) =>
      `${a.teamName} ${a.teamId} ${a.ownerUserId}`.localeCompare(
        `${b.teamName} ${b.teamId} ${b.ownerUserId}`
      )
    );
  if (grants.length === 0) return [];
  const connections = await findGithubRepoConnectionsByOwner(
    grants.map((grant) => ({ userId: grant.ownerUserId, canonicalRef: grant.accountId }))
  );
  const granted = await findGrantedRepoPairs(
    connections.map((connection) => ({ userId: connection.userId, repoUrl: connection.repoUrl }))
  );
  const byOwnerRef = new Map(connections.map((row) => [`${row.userId} ${row.canonicalRef}`, row]));
  const seen = new Set<string>();
  const shared: UsableGithubRepoConnection[] = [];
  for (const grant of grants) {
    const connection = byOwnerRef.get(`${grant.ownerUserId} ${grant.accountId}`);
    if (
      connection === undefined ||
      connection.integrationId !== grant.integrationId ||
      !granted.has(`${connection.userId} ${connection.repoUrl}`) ||
      seen.has(connection.canonicalRef)
    )
      continue;
    seen.add(connection.canonicalRef);
    shared.push({
      ...connection,
      connectedRoseProjectRef: null,
      shared: {
        teamId: grant.teamId,
        teamName: grant.teamName,
        ownerUserId: grant.ownerUserId,
        ownerName: grant.ownerName,
      },
    });
  }
  return shared;
}
