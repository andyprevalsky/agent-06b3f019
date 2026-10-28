import { Prisma } from '@prisma/client';

import { ARCHIVED_AGENT_STATUS_MESSAGE } from '../../providers/agentKill';
import { prisma } from '../../providers/database';
import { agentRanToolsSql, realRootAgentSql } from '../../providers/realAgentRuns';
import { realWaitlistPersonSql } from '../../providers/waitlistIdentity';
import { ADMIN_HEALTH_ADDITIONAL_PHONES, ADMIN_USER_IDS } from './config';
import type { RootTaskRecord } from './repo';

export type ProductRootTaskRecord = Pick<
  RootTaskRecord,
  'taskId' | 'userId' | 'goal' | 'createdAt' | 'status'
> & {
  /** Archived while still running: FAILED by the archive, never a real outcome. */
  archivedBeforeOutcome: boolean;
  /** Andy, Tamara or Aman (by id or phone); their retried goals are collapsed. */
  coreTeam: boolean;
};

const CORE_TEAM_PHONE_DIGITS = [...ADMIN_HEALTH_ADDITIONAL_PHONES].map((phone) => phone.slice(-10));

/** Andy, Tamara or Aman: an admin user id, or a real (non-fixture) person on a core phone. */
export function coreTeamSql(userIdSql: Prisma.Sql, personAlias: string): Prisma.Sql {
  const phoneDigits = Prisma.raw(
    `RIGHT(regexp_replace(COALESCE("${personAlias}".phone, ''), '[^0-9]', '', 'g'), 10)`
  );
  return Prisma.sql`(${userIdSql} IN (${Prisma.join([...ADMIN_USER_IDS])})
    OR (${phoneDigits} IN (${Prisma.join(CORE_TEAM_PHONE_DIGITS)})
        AND ${realWaitlistPersonSql(personAlias)}))`;
}

/**
 * Live roots + latest archived roots -> real agent runs -> completion rate.
 * Runs use the shared real-agent-run shape (providers/realAgentRuns, also used
 * by /biz-review): root, non-benchmark, real world model, at least one
 * non-chat tool call. Population (Andy, October 28 2026): the core team (Andy,
 * Tamara, Aman by user id or phone) plus real people; series.ts then keeps
 * only people subscribed at that period's end (the same Stripe lifecycles the
 * "People in App" card uses, without invite-code redeemers).
 * Unsubscribed users and synthetic/fixture accounts never count.
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
    ), owners AS (
      SELECT roots.*,
             ${coreTeamSql(Prisma.sql`roots."userId"`, 'person')} AS "coreTeam",
             ${realWaitlistPersonSql('person')} AS "realPerson"
      FROM roots
      INNER JOIN "User" person ON person."userId" = roots."userId"
    )
    SELECT owners."taskId", owners."userId", owners.goal, owners."createdAt", owners.status,
           (owners.status = 'FAILED'
             AND owners."statusMessage" IS NOT DISTINCT FROM ${ARCHIVED_AGENT_STATUS_MESSAGE})
             AS "archivedBeforeOutcome",
           owners."coreTeam"
    FROM owners
    WHERE owners."coreTeam" OR owners."realPerson"
  `);
}
