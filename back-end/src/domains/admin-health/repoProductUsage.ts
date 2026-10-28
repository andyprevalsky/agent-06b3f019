import { Prisma } from '@prisma/client';

import { ARCHIVED_AGENT_STATUS_MESSAGE } from '../../providers/agentKill';
import { prisma } from '../../providers/database';
import {
  agentRanToolsSql,
  realRootAgentSql,
  realTaskOwnerSql,
} from '../../providers/realAgentRuns';
import type { RootTaskRecord } from './repo';

export type ProductRootTaskRecord = Pick<
  RootTaskRecord,
  'taskId' | 'userId' | 'goal' | 'createdAt' | 'status'
> & {
  /** Archived while still running: FAILED by the archive, never a real outcome. */
  archivedBeforeOutcome: boolean;
};

/**
 * Live roots + latest archived roots -> real agent runs -> completion rate.
 * Uses the shared real-agent-run definition (providers/realAgentRuns, also used
 * by /biz-review): root, non-benchmark, real world model, operator or real
 * person, and at least one non-chat tool call. The core team is the in-app
 * population today, so the old customer-only cohort was empty and the rate was
 * stuck at 0%; their repeated test goals are collapsed in series.ts instead.
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
             history."originalAgentId", history."userId", history.goal,
             history."agentCreatedAt", history.status, history."statusMessage",
             history."wasAgentRun", history."isBenchmark", history."worldModelMode"
      FROM "GoalHistory" history
      WHERE history.depth = 0
        AND history."agentCreatedAt" >= ${start} AND history."agentCreatedAt" < ${end}
        AND NOT EXISTS (SELECT 1 FROM "Agent" live WHERE live.id = history."originalAgentId")
      ORDER BY history."originalAgentId", history."agentUpdatedAt" DESC,
               history."archivedAt" DESC, history.id DESC
    ), roots AS (
      SELECT agent.id AS "taskId", agent."userId", agent.goal, agent."createdAt",
             agent.status, agent."statusMessage"
      FROM "Agent" agent
      WHERE ${realRootAgentSql('agent')}
        AND agent."createdAt" >= ${start} AND agent."createdAt" < ${end}
        AND ${agentRanToolsSql('agent')}
      UNION ALL
      SELECT history."originalAgentId" AS "taskId", history."userId", history.goal,
             history."agentCreatedAt" AS "createdAt", history.status, history."statusMessage"
      FROM archived history
      -- Filter after DISTINCT ON: the latest archive row decides provenance.
      WHERE history."wasAgentRun" = true AND history."isBenchmark" = false
        AND history."worldModelMode" = 'real'
    )
    SELECT roots."taskId", roots."userId", roots.goal, roots."createdAt", roots.status,
           (roots.status = 'FAILED'
             AND roots."statusMessage" IS NOT DISTINCT FROM ${ARCHIVED_AGENT_STATUS_MESSAGE})
             AS "archivedBeforeOutcome"
    FROM roots
    INNER JOIN "User" person ON person."userId" = roots."userId"
    WHERE ${realTaskOwnerSql(Prisma.sql`roots."userId"`, 'person')}
  `);
}
