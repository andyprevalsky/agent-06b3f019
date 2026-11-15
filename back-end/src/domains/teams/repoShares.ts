import { prisma } from '../../providers/database';
import { SHAREABLE_PROVIDERS } from './config';
import { shareableAccounts } from './repoShareableAccounts';
import { TeamError, type Prisma, type ShareableAccount, type TeamAccessFilter } from './types';
import { mutateTeam, userSelect } from './repoCore';
export { shareableAccounts } from './repoShareableAccounts';
export async function selectAccount(
  userId: string,
  selector: string,
  accountId?: string,
  client: Prisma.TransactionClient = prisma
): Promise<ShareableAccount> {
  const choices = (await shareableAccounts(userId, client)).filter(
    (row) =>
      (row.id === selector || row.integrationId === selector) &&
      (accountId === undefined || row.accountId === accountId)
  );
  if (choices.length !== 1) throw new TeamError(400, 'Select one connected, shareable account');
  return choices[0];
}
export const putIntegrationShare = (
  userId: string,
  teamId: string,
  selector: string,
  accountId?: string
) =>
  mutateTeam(userId, teamId, async (tx) => {
    const account = await selectAccount(userId, selector, accountId, tx);
    const { integrationId, provider, accountEmail } = account;
    return tx.teamIntegrationShare.upsert({
      where: {
        teamId_integrationId_accountId: { teamId, integrationId, accountId: account.accountId },
      },
      update: {},
      create: {
        teamId,
        integrationId,
        ownerUserId: userId,
        provider,
        accountId: account.accountId,
        accountEmail,
      },
    });
  });
export const deleteIntegrationShare = (
  userId: string,
  teamId: string,
  selector: string,
  accountId?: string
) =>
  mutateTeam(userId, teamId, async (tx) => {
    const credential = await tx.emailIntegrationCredential.findFirst({
      where: { id: selector, userId },
      select: { integrationId: true, email: true },
    });
    const integration = await tx.integration.findFirst({
      where: { id: selector, userId },
      select: { id: true },
    });
    // A Plaid share names one institution login; unsharing must work even after it disconnects.
    const item =
      credential || integration
        ? null
        : await tx.plaidItem.findFirst({
            where: { id: selector, userId },
            select: { id: true, integrationId: true },
          });
    if (!credential && !integration && !item) throw new TeamError(404, 'Account not found');
    await tx.teamIntegrationShare.deleteMany({
      where: {
        teamId,
        ownerUserId: userId,
        integrationId: credential?.integrationId ?? item?.integrationId ?? selector,
        ...(credential?.email !== undefined && credential?.email !== null
          ? { accountId: credential.email.trim().toLowerCase() }
          : item
            ? { accountId: item.id }
            : accountId !== undefined
              ? { accountId }
              : {}),
      },
    });
  });

export const integrationShares = (userId: string, filters: TeamAccessFilter = {}) =>
  prisma.teamIntegrationShare.findMany({
    where: {
      ...(filters.teamId !== undefined ? { teamId: filters.teamId } : {}),
      ...(filters.ownerUserId !== undefined ? { ownerUserId: filters.ownerUserId } : {}),
      team: { members: { some: { userId, status: 'ACCEPTED' } } },
      integration: {
        status: 'CONNECTED',
        isActive: true,
        name: { in: [...SHAREABLE_PROVIDERS] },
      },
    },
    include: {
      integration: { include: { emailCredentials: { where: { state: 'connected' } } } },
      team: {
        include: {
          members: { where: { status: 'ACCEPTED' }, include: { user: { select: userSelect } } },
        },
      },
    },
  });
export const projectShares = (userId: string) =>
  prisma.teamProjectShare.findMany({
    where: { team: { members: { some: { userId, status: 'ACCEPTED' } } } },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          userId: true,
          agents: {
            where: { deletedAt: null },
            take: 21,
            orderBy: { updatedAt: 'desc' },
            select: { id: true, title: true, status: true, userId: true },
          },
        },
      },
      team: {
        include: {
          members: { where: { status: 'ACCEPTED' }, include: { user: { select: userSelect } } },
        },
      },
    },
  });
export const putProjectShare = (userId: string, teamId: string, projectId: string) =>
  mutateTeam(userId, teamId, async (tx) => {
    if (!(await tx.project.findFirst({ where: { id: projectId, userId }, select: { id: true } })))
      throw new TeamError(404, 'Project not found');
    return tx.teamProjectShare.upsert({
      where: { teamId_projectId: { teamId, projectId } },
      create: { teamId, projectId, ownerUserId: userId },
      update: {},
    });
  });
export const deleteProjectShare = (userId: string, teamId: string, projectId: string) =>
  mutateTeam(userId, teamId, async (tx) => {
    if (!(await tx.project.findFirst({ where: { id: projectId, userId }, select: { id: true } })))
      throw new TeamError(404, 'Project not found');
    await tx.teamProjectShare.deleteMany({ where: { teamId, projectId, ownerUserId: userId } });
  });
