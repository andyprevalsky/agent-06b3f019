import { Prisma } from '@prisma/client';

import { prisma } from '../../providers/database';
import { realWaitlistPersonSql } from '../../providers/waitlistIdentity';
import { ADMIN_HEALTH_ADDITIONAL_PHONES, ADMIN_USER_IDS } from './config';
import type { RootTaskRecord } from './repo';

export type ProductRootTaskRecord = Pick<RootTaskRecord, 'taskId' | 'createdAt' | 'status'>;

/**
 * Live roots + latest archived roots -> real customer usage -> completion rate.
 * Operator accounts also hold unmarked historical tests, so completion measures
 * customers only. Other health metrics (including resource costs) keep their
 * own populations. Never guess provenance from goal wording or repetitions.
 * Indexed date windows and an indexed live-ID anti-join keep this a single
 * dashboard query, with no per-agent requests or new runtime bookkeeping.
 */
export async function findProductRootTasksBetween(
  start: Date,
  end: Date
): Promise<ProductRootTaskRecord[]> {
  return prisma.$queryRaw<ProductRootTaskRecord[]>(Prisma.sql`
    WITH archived AS (
      SELECT DISTINCT ON (history."originalAgentId")
             history."originalAgentId", history."userId",
             history."agentCreatedAt", history.status,
             history."isBenchmark", history."worldModelMode"
      FROM "GoalHistory" history
      WHERE history.depth = 0
        AND history."agentCreatedAt" >= ${start} AND history."agentCreatedAt" < ${end}
        AND NOT EXISTS (SELECT 1 FROM "Agent" live WHERE live.id = history."originalAgentId")
      ORDER BY history."originalAgentId", history."agentUpdatedAt" DESC,
               history."archivedAt" DESC, history.id DESC
    ), roots AS (
      SELECT id AS "taskId", "userId", "createdAt", status,
             "isBenchmark", "worldModelMode"
      FROM "Agent"
      WHERE "parentAgentId" IS NULL AND depth = 0
        AND "createdAt" >= ${start} AND "createdAt" < ${end}
      UNION ALL
      SELECT
             history."originalAgentId" AS "taskId", history."userId",
             history."agentCreatedAt" AS "createdAt", history.status,
             history."isBenchmark", history."worldModelMode"
      FROM archived history
    )
    SELECT roots."taskId", roots."createdAt", roots.status
    FROM roots
    INNER JOIN "User" person ON person."userId" = roots."userId"
    WHERE roots."isBenchmark" = false AND roots."worldModelMode" = 'real'
      AND roots."userId" NOT IN (${Prisma.join([...ADMIN_USER_IDS])})
      AND RIGHT(regexp_replace(COALESCE(person.phone, ''), '[^0-9]', '', 'g'), 10)
          NOT IN (${Prisma.join([...ADMIN_HEALTH_ADDITIONAL_PHONES].map((phone) => phone.slice(-10)))})
      AND ${realWaitlistPersonSql('person')}
  `);
}
