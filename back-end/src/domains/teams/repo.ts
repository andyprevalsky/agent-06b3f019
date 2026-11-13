import { prisma, runTransactionWithRetry } from '../../providers/database';
import { TeamError } from './types';
import { mutateTeam, userSelect } from './repoCore';
import { INVITE_SENDING_LEASE_MS } from './config';

export const findUser = (userId: string) =>
  prisma.user.findUnique({ where: { userId }, select: userSelect });
export const findUsersByEmail = (email: string) =>
  prisma.user.findMany({
    where: { email: { equals: email, mode: 'insensitive' }, isAnonymous: false },
    select: userSelect,
    take: 2,
  });

export const memberships = (userId: string) =>
  prisma.teamMember.findMany({
    where: { userId, status: 'ACCEPTED' },
    include: { team: true },
    orderBy: { createdAt: 'asc' },
  });
export const invitations = (email: string) =>
  prisma.teamMember.findMany({
    where: { email, status: 'INVITED' },
    include: { team: true },
    orderBy: { createdAt: 'asc' },
  });
const teamDetailsInclude = {
  members: { include: { user: { select: userSelect } }, orderBy: { createdAt: 'asc' as const } },
};
export const teamDetails = (id: string) =>
  prisma.team.findUnique({ where: { id }, include: teamDetailsInclude });
/** Preserve membership ordering while fetching every accepted team's roster in one batch. */
export const memberTeamDetails = (userId: string) =>
  prisma.teamMember.findMany({
    where: { userId, status: 'ACCEPTED' },
    select: { role: true, team: { include: teamDetailsInclude } },
    orderBy: { createdAt: 'asc' },
  });
export const renameTeam = (userId: string, id: string, name: string) =>
  mutateTeam(userId, id, async (tx, member) => {
    if (member.role !== 'OWNER') throw new TeamError(403, 'Only the team owner can rename it');
    return tx.team.update({ where: { id }, data: { name } });
  });
export async function createTeam(userId: string, email: string | null, name: string) {
  return prisma.team.create({
    data: {
      ownerUserId: userId,
      name,
      members: {
        create: { userId, email, role: 'OWNER', status: 'ACCEPTED', acceptedAt: new Date() },
      },
    },
  });
}
/** Explicit operator bootstrap, serialized so retries do not create duplicate teams. */
export async function ensureTeam(userId: string, email: string | null, name: string) {
  return runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}), hashtext(${name}))`;
    const matches = await tx.team.findMany({ where: { ownerUserId: userId, name }, take: 2 });
    if (matches.length > 1)
      throw new TeamError(409, 'Multiple matching teams; select a team explicitly');
    return (
      matches[0] ??
      tx.team.create({
        data: {
          ownerUserId: userId,
          name,
          members: {
            create: { userId, email, role: 'OWNER', status: 'ACCEPTED', acceptedAt: new Date() },
          },
        },
      })
    );
  });
}
export const invite = (userId: string, teamId: string, email: string) =>
  mutateTeam(userId, teamId, async (tx, member) => {
    if (member.role !== 'OWNER') throw new TeamError(403, 'Only the team owner can invite members');
    const users = await tx.user.findMany({
      where: { email: { equals: email, mode: 'insensitive' }, isAnonymous: false },
      take: 2,
      select: userSelect,
    });
    if (users.length > 1) throw new TeamError(409, 'This email matches more than one account');
    const existing = await tx.teamMember.findUnique({ where: { teamId_email: { teamId, email } } });
    if (existing) return existing;
    return tx.teamMember.create({ data: { teamId, email, userId: users[0]?.userId } });
  });
export async function accept(
  userId: string,
  teamId: string,
  email: string | null,
  tokenHash?: string,
  trusted = false
) {
  return runTransactionWithRetry(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${teamId} FOR UPDATE`;
    const accepted = await tx.teamMember.findFirst({
      where: { teamId, userId, status: 'ACCEPTED' },
    });
    if (accepted) return accepted;
    const member =
      tokenHash !== undefined
        ? await tx.teamMember.findFirst({
            where: { teamId, inviteTokenHash: tokenHash, status: 'INVITED' },
          })
        : email !== null
          ? await tx.teamMember.findUnique({ where: { teamId_email: { teamId, email } } })
          : null;
    if (!member && !trusted)
      throw new TeamError(
        403,
        'Open the invitation email to accept this team invitation',
        'INVITE_TOKEN_REQUIRED'
      );
    if (
      !member ||
      (email !== null && member.email !== email) ||
      (trusted && member.userId !== null && member.userId !== userId)
    )
      throw new TeamError(404, 'Invitation not found');
    // A token alone never transfers an invitation already bound to another account.
    if (member.userId !== null && member.userId !== userId)
      throw new TeamError(403, 'This invitation belongs to another account');
    if (
      member.status === 'INVITED' &&
      !trusted &&
      (tokenHash === undefined ||
        member.inviteTokenHash === null ||
        member.inviteTokenHash !== tokenHash)
    )
      throw new TeamError(
        403,
        'Open the invitation email to accept this team invitation',
        'INVITE_TOKEN_REQUIRED'
      );
    if (email !== null) {
      const users = await tx.user.findMany({
        where: { email: { equals: email, mode: 'insensitive' }, isAnonymous: false },
        select: { userId: true },
        take: 2,
      });
      if (users.length !== 1 || users[0].userId !== userId)
        throw new TeamError(409, 'Email does not identify one account');
    }
    return tx.teamMember.update({
      where: { id: member.id },
      data: {
        userId,
        status: 'ACCEPTED',
        acceptedAt: member.acceptedAt ?? new Date(),
        inviteTokenHash: null,
      },
    });
  });
}
export const invitationByToken = (teamId: string, tokenHash: string) =>
  prisma.teamMember.findFirst({
    where: { teamId, inviteTokenHash: tokenHash, status: 'INVITED' },
    include: { team: true },
  });
export const removeMember = (userId: string, teamId: string, memberId: string) =>
  mutateTeam(userId, teamId, async (tx, actor) => {
    const member = await tx.teamMember.findFirst({ where: { id: memberId, teamId } });
    if (!member) throw new TeamError(404, 'Member not found');
    if (member.role === 'OWNER') throw new TeamError(403, 'The team owner cannot leave');
    if (actor.role !== 'OWNER' && member.userId !== userId)
      throw new TeamError(403, 'Cannot remove another member');
    if (member.userId !== null) {
      await tx.teamIntegrationShare.deleteMany({ where: { teamId, ownerUserId: member.userId } });
      await tx.teamProjectShare.deleteMany({ where: { teamId, ownerUserId: member.userId } });
    }
    await tx.teamMember.delete({ where: { id: member.id } });
  });

export * from './repoShares';
export const contactRows = (userId: string, q: string) => {
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  return prisma.$queryRaw<
    Array<{ firstName: string; lastName: string; email: string | null; emailAddresses: unknown }>
  >`
    SELECT "firstName", "lastName", "email", "emailAddresses" FROM "Person"
    WHERE "userId" = ${userId} AND (
      "firstName" ILIKE ${pattern} OR "lastName" ILIKE ${pattern} OR
      "email" ILIKE ${pattern} OR "emailAddresses"::text ILIKE ${pattern})
    ORDER BY "firstName", "id" LIMIT 100`;
};
export const usersForEmails = (emails: string[]) =>
  prisma.user.findMany({
    where: {
      isAnonymous: false,
      OR: emails.map((email) => ({ email: { equals: email, mode: 'insensitive' as const } })),
    },
    select: userSelect,
  });
/** Claims one send. UNKNOWN (possibly delivered) is reclaimed only on an explicit owner retry;
 * a SENDING claim older than the lease is presumed crashed before finishDelivery. */
export const claimDelivery = (
  id: string,
  tokenHash: string,
  { retryUnknown = false, now = new Date() }: { retryUnknown?: boolean; now?: Date } = {}
) =>
  prisma.teamMember.updateMany({
    where: {
      id,
      status: 'INVITED',
      OR: [
        {
          inviteDeliveryStatus: {
            in: ['PENDING', 'FAILED', 'UNAVAILABLE', ...(retryUnknown ? ['UNKNOWN'] : [])],
          },
        },
        {
          inviteDeliveryStatus: 'SENDING',
          updatedAt: { lt: new Date(now.getTime() - INVITE_SENDING_LEASE_MS) },
        },
      ],
    },
    data: { inviteDeliveryStatus: 'SENDING', inviteTokenHash: tokenHash },
  });
export const finishDelivery = (id: string, status: string, messageId?: string) =>
  prisma.teamMember.updateMany({
    where: { id, inviteDeliveryStatus: 'SENDING' },
    data: {
      inviteDeliveryStatus: status,
      ...(messageId !== undefined ? { inviteMessageId: messageId } : {}),
    },
  });
