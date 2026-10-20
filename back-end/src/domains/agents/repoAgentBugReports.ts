/**
 * One bug-report claim per agent, in the shared ToolSideEffect idempotency table.
 *
 *   operationKey  agent-bug-report:<agentId>   (unique → at most one claim per agent)
 *   status        STARTED   launch in flight (externalId = claim owner)
 *                 SUCCEEDED a report exists   (externalId = boxes.dev run id)
 *                 FAILED    launch failed     (request.nextAttemptAt = retry time, null = gave up)
 *
 * The manual Report Bug button and the 24h stuck-agent job both write it, so an
 * agent that already has either report is never reported again. A STARTED claim
 * whose owner died mid-launch becomes reclaimable after `staleBefore`.
 */

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../providers/database';
import {
  agentRanToolsSql,
  realRootAgentSql,
  realTaskOwnerSql,
} from '../../providers/realAgentRuns';

export const AGENT_BUG_REPORT_OPERATION_TYPE = 'AGENT_BUG_REPORT';

export type AgentBugReportSource = 'manual' | 'stuck_24h';

export function agentBugReportKey(agentId: string): string {
  return `agent-bug-report:${agentId}`;
}

export interface StuckAgentCandidate {
  id: string;
  status: string;
  title: string;
}

export interface FindStuckAgentCandidatesInput {
  createdFrom: Date;
  createdBefore: Date;
  now: Date;
  staleBefore: Date;
  limit: number;
  candidateAgentIds?: string[];
}

/** A failed launch whose retry time has passed, or a launch whose owner died. */
function reclaimableSql(alias: string, now: Date, staleBefore: Date): Prisma.Sql {
  const row = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(
    (${row}.status = 'FAILED'
      AND ${row}.request->>'nextAttemptAt' IS NOT NULL
      AND (${row}.request->>'nextAttemptAt')::timestamptz <= ${now})
    OR (${row}.status = 'STARTED' AND ${row}."updatedAt" <= ${staleBefore}))`;
}

/** Live real prod agent runs created in the window, not COMPLETED, with no report yet. */
export async function findStuckAgentCandidates(
  input: FindStuckAgentCandidatesInput
): Promise<StuckAgentCandidate[]> {
  if (input.candidateAgentIds?.length === 0) return [];
  const scope =
    input.candidateAgentIds === undefined
      ? Prisma.empty
      : Prisma.sql`AND agent.id IN (${Prisma.join(input.candidateAgentIds)})`;
  return prisma.$queryRaw<StuckAgentCandidate[]>(Prisma.sql`
    SELECT agent.id, agent.status::text AS status,
           COALESCE(NULLIF(agent.title, ''), agent.goal) AS title
    FROM "Agent" agent
    INNER JOIN "User" person ON person."userId" = agent."userId"
    WHERE ${realRootAgentSql('agent')}
      AND agent."deletedAt" IS NULL
      AND agent.status <> 'COMPLETED'
      AND agent."createdAt" >= ${input.createdFrom}
      AND agent."createdAt" <= ${input.createdBefore}
      AND ${realTaskOwnerSql(Prisma.sql`agent."userId"`, 'person')}
      AND ${agentRanToolsSql('agent')}
      AND NOT EXISTS (
        SELECT 1 FROM "ToolSideEffect" report
        WHERE report."operationKey" = ${agentBugReportKey('')} || agent.id
          AND NOT ${reclaimableSql('report', input.now, input.staleBefore)})
      ${scope}
    ORDER BY agent."createdAt" ASC
    LIMIT ${input.limit}
  `);
}

/** Atomically claim the agent's report slot; true only for the winning owner. */
export async function claimStuckAgentBugReport(
  agentId: string,
  ownerId: string,
  now: Date,
  staleBefore: Date
): Promise<boolean> {
  const request = { agentId, source: 'stuck_24h', attempts: 1 };
  const rows = await prisma.$queryRaw<Array<{ externalId: string | null }>>(Prisma.sql`
    INSERT INTO "ToolSideEffect"
      (id, "operationKey", "operationType", status, "externalId", request, "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${agentBugReportKey(agentId)}, ${AGENT_BUG_REPORT_OPERATION_TYPE},
       'STARTED', ${ownerId}, ${JSON.stringify(request)}::jsonb, ${now}, ${now})
    ON CONFLICT ("operationKey") DO UPDATE SET
      status = 'STARTED',
      "externalId" = EXCLUDED."externalId",
      request = COALESCE("ToolSideEffect".request, '{}'::jsonb) || jsonb_build_object(
        'attempts', COALESCE(("ToolSideEffect".request->>'attempts')::int, 0) + 1,
        'nextAttemptAt', NULL),
      error = NULL,
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE ${reclaimableSql('ToolSideEffect', now, staleBefore)}
    RETURNING "externalId"
  `);
  return rows[0]?.externalId === ownerId;
}

/** Attempts recorded on the claim, including the current one. */
export async function readAgentBugReportAttempts(agentId: string): Promise<number> {
  const row = await prisma.toolSideEffect.findUnique({
    where: { operationKey: agentBugReportKey(agentId) },
    select: { request: true },
  });
  const attempts = (row?.request as { attempts?: unknown } | null)?.attempts;
  return typeof attempts === 'number' ? attempts : 0;
}

export async function markStuckAgentBugReportLaunched(
  agentId: string,
  ownerId: string,
  runId: string,
  now: Date
): Promise<boolean> {
  const result = await prisma.toolSideEffect.updateMany({
    where: { operationKey: agentBugReportKey(agentId), status: 'STARTED', externalId: ownerId },
    data: {
      status: 'SUCCEEDED',
      externalId: runId,
      response: { runId, launchedAt: now.toISOString() },
    },
  });
  return result.count === 1;
}

/** Record a failed launch; `nextAttemptAt` null means no further retries. */
export async function markStuckAgentBugReportFailed(
  agentId: string,
  ownerId: string,
  error: string,
  nextAttemptAt: Date | null
): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "ToolSideEffect" SET
      status = 'FAILED',
      error = ${error.slice(0, 2000)},
      request = COALESCE(request, '{}'::jsonb)
        || jsonb_build_object('nextAttemptAt', ${nextAttemptAt?.toISOString() ?? null}::text),
      "updatedAt" = now()
    WHERE "operationKey" = ${agentBugReportKey(agentId)}
      AND status = 'STARTED' AND "externalId" = ${ownerId}
  `);
}

/** Stuck-agent reports created in [since, until] (launched or in flight), for the daily cap. */
export async function countStuckAgentBugReportsBetween(since: Date, until: Date): Promise<number> {
  return prisma.toolSideEffect.count({
    where: {
      operationType: AGENT_BUG_REPORT_OPERATION_TYPE,
      createdAt: { gte: since, lte: until },
      status: { in: ['STARTED', 'SUCCEEDED'] },
      request: { path: ['source'], equals: 'stuck_24h' },
    },
  });
}

/** A manual Report Bug launch also marks the agent reported. */
export async function recordManualAgentBugReport(agentId: string, runId: string): Promise<void> {
  const now = new Date();
  const request = { agentId, source: 'manual', runId };
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "ToolSideEffect"
      (id, "operationKey", "operationType", status, "externalId", request, "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${agentBugReportKey(agentId)}, ${AGENT_BUG_REPORT_OPERATION_TYPE},
       'SUCCEEDED', ${runId}, ${JSON.stringify(request)}::jsonb, ${now}, ${now})
    ON CONFLICT ("operationKey") DO UPDATE SET
      status = 'SUCCEEDED',
      "externalId" = EXCLUDED."externalId",
      request = COALESCE("ToolSideEffect".request, '{}'::jsonb) || EXCLUDED.request,
      error = NULL,
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE "ToolSideEffect".status <> 'SUCCEEDED'
  `);
}
