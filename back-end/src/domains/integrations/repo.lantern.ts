import { prisma, runTransactionWithRetry } from '../../providers/database';
import type { Prisma } from './types';

const name = 'lantern_people';
const key = (userId: string) => ({ userId_name_accountId: { userId, name, accountId: '' } });

export function findLanternIntegration(userId: string) {
  return prisma.integration.findUnique({ where: key(userId) });
}

/** Refresh leases use the database clock, independently of each app instance. */
export async function isLanternRefreshClaimLive(deadline: number): Promise<boolean> {
  return refreshClaimLive(prisma, deadline);
}

async function refreshClaimLive(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  deadline: number
): Promise<boolean> {
  const rows = await client.$queryRaw<{ live: boolean }[]>`
    SELECT clock_timestamp() < to_timestamp(${deadline}::double precision / 1000.0) AS live`;
  return rows[0]?.live === true;
}

/** A tenant-specific native lock also serializes upload against refresh. */
export function withLanternCredentialLock<T>(
  userId: string,
  run: (store: ReturnType<typeof lockedStore>) => Promise<T>
): Promise<T> {
  return runTransactionWithRetry(
    async (tx) => {
      await tx.$queryRaw`SELECT set_config('lock_timeout', '2000ms', true)`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`lantern_people:${userId}`}, 0))::text`;
      return run(lockedStore(tx, userId));
    },
    { maxWait: 500, timeout: 3000, maxRetries: 1 }
  );
}

function lockedStore(tx: Prisma.TransactionClient, userId: string) {
  return {
    find: () => tx.integration.findUnique({ where: key(userId) }),
    isRefreshClaimLive: (deadline: number) => refreshClaimLive(tx, deadline),
    setActive: (isActive: boolean) =>
      tx.integration.update({ where: key(userId), data: { isActive } }),
    remove: () => tx.integration.delete({ where: key(userId) }),
    save: (encryptedCredentials: string) =>
      tx.integration.upsert({
        where: key(userId),
        create: {
          userId,
          name,
          accountId: '',
          type: 'TOOL_SETUP',
          status: 'CONNECTED',
          isActive: true,
          config: { encryptedCredentials },
        },
        update: {
          type: 'TOOL_SETUP',
          status: 'CONNECTED',
          isActive: true,
          failureReason: null,
          config: { encryptedCredentials },
        },
      }),
    // The claim commits in this SAME short transaction; HTTP starts only after commit.
    markRefreshPending: async (id: string, encryptedCredentials: string, nonce: string) => {
      const rows = await tx.$queryRaw<{ claim: string }[]>`
        WITH timing AS MATERIALIZED (
          SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint + 20000 AS deadline
        )
        UPDATE "Integration" SET status = 'EXPIRED',
          "failureReason" = 'lantern_refresh_pending:' || timing.deadline::text || ':' || ${nonce},
          "updatedAt" = clock_timestamp()
        FROM timing WHERE id = ${id} AND status = 'CONNECTED' AND "isActive" = true
          AND config->>'encryptedCredentials' = ${encryptedCredentials}
        RETURNING "failureReason" AS claim`;
      return { count: rows.length, claim: rows[0]?.claim };
    },
    // Admission is a short native check after the claim committed, never an HTTP transaction.
    admitRefresh: async (id: string, original: string, claim: string) => {
      const deadline = Number(claim.split(':')[1]);
      const rows = await tx.$queryRaw<{ remainingMs: number }[]>`
        SELECT (${deadline}::double precision - extract(epoch FROM clock_timestamp()) * 1000)::double precision AS "remainingMs"
        FROM "Integration" WHERE id = ${id} AND status = 'EXPIRED' AND "isActive" = true
          AND "failureReason" = ${claim} AND config->>'encryptedCredentials' = ${original}
          AND clock_timestamp() < to_timestamp(${deadline}::double precision / 1000.0)`;
      return rows[0]?.remainingMs ?? 0;
    },
    finishRefresh: async (
      id: string,
      original: string,
      claim: string,
      encryptedCredentials?: string
    ) => {
      // Evaluate expiry at the write boundary, including time spent acquiring the lock.
      const deadline = Number(claim.split(':')[1]);
      const count =
        encryptedCredentials === undefined
          ? await tx.$executeRaw`UPDATE "Integration" SET "failureReason" = 'lantern_refresh_outcome_unknown', "updatedAt" = clock_timestamp()
            WHERE id = ${id} AND status = 'EXPIRED' AND "isActive" = true
            AND "failureReason" = ${claim} AND config->>'encryptedCredentials' = ${original}`
          : await tx.$executeRaw`UPDATE "Integration" SET status = 'CONNECTED', "failureReason" = NULL,
            config = jsonb_build_object('encryptedCredentials', ${encryptedCredentials}::text), "updatedAt" = clock_timestamp()
            WHERE id = ${id} AND status = 'EXPIRED' AND "isActive" = true
            AND "failureReason" = ${claim} AND config->>'encryptedCredentials' = ${original}
            AND clock_timestamp() < to_timestamp(${deadline}::double precision / 1000.0)`;
      return { count };
    },
  };
}
