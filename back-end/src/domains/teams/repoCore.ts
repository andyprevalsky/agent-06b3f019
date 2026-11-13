import { runTransactionWithRetry } from '../../providers/database';
import { TeamError, type Prisma } from './types';
export const userSelect = { userId: true, name: true, email: true, isAnonymous: true } as const;
/** Serialize membership/share mutations on the same team, including revocation. */
export async function mutateTeam<T>(
  userId: string,
  teamId: string,
  fn: (tx: Prisma.TransactionClient, member: { id: string; role: string }) => Promise<T>
): Promise<T> {
  return runTransactionWithRetry(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Team" WHERE "id" = ${teamId} FOR UPDATE`;
    const member = await tx.teamMember.findFirst({ where: { teamId, userId, status: 'ACCEPTED' } });
    if (!member) throw new TeamError(404, 'Team not found');
    return fn(tx, member);
  });
}
