/**
 * UI → routes → service → repo → current memberships + explicit account grants.
 * No credentials cross this boundary. Shared projects expose discovery metadata.
 */
import { createLogger } from '../../providers/logger';
import { createHash, randomBytes } from 'node:crypto';
import {
  sendTransactionalEmail,
  TransactionalEmailDefinitiveError,
} from '../../providers/transactionalEmail';
import { inviteSender, inviteUrl } from './config';
import * as repo from './repo';
import { normalizedEmail, TeamError, type TeamAccessFilter } from './types';

import { requireUser, requireMemberUser } from './serviceIdentity';
import { resolveTeamDataAccess, listSharedProjects } from './serviceAccess';
import { indexTeamPresentation, memberDto, teamDto } from './servicePresentation';
export { requireUser } from './serviceIdentity';
export { resolveTeamDataAccess, listSharedProjects, getTeamContext } from './serviceAccess';
const log = createLogger('Teams');
export { TeamError } from './types';

async function loadTeamPresentation(
  userId: string,
  teams: NonNullable<Awaited<ReturnType<typeof repo.teamDetails>>>[],
  filters: TeamAccessFilter = {}
) {
  const emails = [
    ...new Set(
      teams.flatMap((team) =>
        team.members.flatMap((member) => (member.email === null ? [] : [member.email]))
      )
    ),
  ];
  const [grants, { projects }, users] = await Promise.all([
    resolveTeamDataAccess(userId, filters),
    listSharedProjects(userId),
    repo.usersForEmails(emails),
  ]);
  return indexTeamPresentation(grants, projects, users);
}
export async function getTeam(userId: string, teamId: string) {
  const team = await repo.teamDetails(teamId);
  const actor = team?.members.find(
    (member) => member.userId === userId && member.status === 'ACCEPTED'
  );
  if (!team || !actor) throw new TeamError(404, 'Team not found');
  return teamDto(team, actor.role, await loadTeamPresentation(userId, [team], { teamId }));
}
export async function listTeams(userId: string) {
  const user = await requireUser(userId);
  const [members, pending] = await Promise.all([
    repo.memberTeamDetails(userId),
    user.email !== null && user.email !== '' && !user.isAnonymous
      ? repo.invitations(user.email.trim().toLowerCase())
      : Promise.resolve([]),
  ]);
  const indexed =
    members.length === 0
      ? indexTeamPresentation([], [], [])
      : await loadTeamPresentation(
          userId,
          members.map((member) => member.team)
        );
  return {
    teams: members.map(({ team, role }) => teamDto(team, role, indexed)),
    invitations: pending.map((member) => ({
      id: member.teamId,
      name: member.team.name,
      ownerUserId: member.team.ownerUserId,
      createdAt: member.team.createdAt.toISOString(),
      updatedAt: member.team.updatedAt.toISOString(),
      role: member.role,
      status: 'INVITED',
      members: [],
      integrationShares: [],
      projectShares: [],
    })),
  };
}
export async function createTeam(userId: string, name: string) {
  const user = await requireMemberUser(userId);
  const team = await repo.createTeam(userId, user.email, name);
  log.info('Team created', { userId, teamId: team.id });
  return getTeam(userId, team.id);
}
export async function bootstrapTeam(
  userId: string,
  expectedOwnerEmail: string | undefined,
  name: string,
  inviteEmail: string,
  send = sendTransactionalEmail
) {
  const user = await requireMemberUser(userId);
  if (expectedOwnerEmail !== undefined && user.email !== normalizedEmail(expectedOwnerEmail))
    throw new TeamError(409, 'Owner email does not match the selected account');
  const team = await repo.ensureTeam(userId, user.email, name);
  const invitation = await inviteMember(userId, team.id, normalizedEmail(inviteEmail), send);
  return { team: await getTeam(userId, team.id), invitation };
}
export async function renameTeam(userId: string, id: string, name: string) {
  await repo.renameTeam(userId, id, name);
  return getTeam(userId, id);
}
export async function inviteMember(
  userId: string,
  teamId: string,
  email: string,
  send = sendTransactionalEmail,
  retryUnknown = false
) {
  await requireMemberUser(userId);
  const member = await repo.invite(userId, teamId, email);
  const team = await repo.teamDetails(teamId);
  const sender = inviteSender();
  let delivery = member.inviteDeliveryStatus;
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  if (
    member.status === 'INVITED' &&
    (await repo.claimDelivery(member.id, tokenHash, { retryUnknown })).count
  ) {
    delivery = 'UNAVAILABLE';
    if (team) {
      try {
        const result = await send({
          ...sender,
          to: email,
          subject: `Invitation to ${team.name} on Rose`,
          body: `You have been invited to join ${team.name} on Rose.\n\nSign in with ${email} and accept the invitation:\n${inviteUrl(teamId, token)}\n\nJoining does not share any integration data. Each account must be explicitly shared by its owner.`,
        });
        delivery = 'SENT';
        await repo.finishDelivery(member.id, delivery, result.id);
      } catch (error) {
        delivery = error instanceof TransactionalEmailDefinitiveError ? 'FAILED' : 'UNKNOWN';
        log.error('Team invite delivery failed', { teamId, memberId: member.id, delivery });
      }
    }
    await repo.finishDelivery(member.id, delivery);
  }
  const updated = (await repo.teamDetails(teamId))?.members.find((row) => row.id === member.id);
  return {
    member: updated ? memberDto(updated) : memberDto({ ...member, user: null }),
    delivery: delivery.toLowerCase(),
  };
}
export async function acceptInvite(
  userId: string,
  teamId: string,
  token?: string,
  trusted = false
) {
  const user = await requireMemberUser(userId);
  await repo.accept(
    userId,
    teamId,
    user.email,
    token !== undefined ? createHash('sha256').update(token).digest('hex') : undefined,
    trusted
  );
  return getTeam(userId, teamId);
}
export async function previewInvitation(userId: string, teamId: string, token: string) {
  await requireMemberUser(userId);
  const member = await repo.invitationByToken(
    teamId,
    createHash('sha256').update(token).digest('hex')
  );
  if (!member) throw new TeamError(404, 'Invitation not found');
  const team = member.team;
  return {
    id: team.id,
    name: team.name,
    ownerUserId: team.ownerUserId,
    createdAt: team.createdAt.toISOString(),
    updatedAt: team.updatedAt.toISOString(),
    role: member.role,
    status: 'INVITED',
    members: [],
    integrationShares: [],
    projectShares: [],
  };
}
export const removeMember = repo.removeMember;
export async function shareIntegration(
  userId: string,
  teamId: string,
  selector: string,
  accountId?: string
) {
  await repo.putIntegrationShare(userId, teamId, selector, accountId);
  return getTeam(userId, teamId);
}
export const unshareIntegration = repo.deleteIntegrationShare;
export async function shareProject(userId: string, teamId: string, projectId: string) {
  await repo.putProjectShare(userId, teamId, projectId);
  return getTeam(userId, teamId);
}
export const unshareProject = repo.deleteProjectShare;
export async function listShareableIntegrations(userId: string) {
  await requireUser(userId);
  const [accounts, grants] = await Promise.all([
    repo.shareableAccounts(userId),
    resolveTeamDataAccess(userId, { ownerUserId: userId }),
  ]);
  return {
    integrations: accounts.map((account) => ({
      ...account,
      teamIds: grants
        .filter(
          (grant) =>
            grant.integrationId === account.integrationId && grant.accountId === account.accountId
        )
        .map((grant) => grant.teamId),
    })),
  };
}
export { contacts } from './serviceContacts';
