/**
 * One bug-report claim per agent, in the shared ToolSideEffect idempotency table.
 *
 *   operationKey  agent-bug-report:<agentId>   (unique → at most one claim per agent)
 *   status        STARTED   launch in flight (externalId = claim owner)
 *                 SUCCEEDED a report exists   (externalId = boxes.dev run id)
 *                 FAILED    launch failed     (request.nextAttemptAt = retry time)
 *   request       the launch name + prompt frozen at the first claim, so every retry
 *                 sends boxes.dev the identical request under the same idempotency key
 *
 * The manual Report Bug button, the root agent's report_bug tool and the 24h
 * stuck-agent job all write it, so an agent that already has any report is never
 * reported again by the job. A STARTED claim whose owner died mid-launch becomes
 * reclaimable after `staleBefore`.
 *
 * The report_bug tool also holds its own claim, one per agent run:
 *
 *   operationKey  agent-self-bug-report:<agentId>  (unique → one tool report per run)
 *   status        STARTED / FAILED  request frozen; any retry re-sends it unchanged
 *                 SUCCEEDED         externalId = boxes.dev run id
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

export type AgentBugReportSource = 'manual' | 'agent' | 'stuck_24h';

/** Separate type so the stuck-agent daily cap and the tool's daily cap never mix. */
export const AGENT_SELF_BUG_REPORT_OPERATION_TYPE = 'AGENT_SELF_BUG_REPORT';

export function agentBugReportKey(agentId: string): string {
  return `agent-bug-report:${agentId}`;
}

export function agentSelfBugReportKey(agentId: string): string {
  return `agent-self-bug-report:${agentId}`;
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
    ORDER BY agent."createdAt" DESC
    LIMIT ${input.limit}
  `);
}

export interface StuckAgentLaunchRequest {
  name: string;
  promptText: string;
}

export interface StuckAgentBugReportClaim extends StuckAgentLaunchRequest {
  attempts: number;
}

/**
 * Atomically claim the agent's report slot. Returns the frozen launch request
 * (the first claim's name + prompt) for the winning owner, or null.
 */
export async function claimStuckAgentBugReport(
  agentId: string,
  ownerId: string,
  launch: StuckAgentLaunchRequest,
  claimedAt: Date,
  now: Date,
  staleBefore: Date
): Promise<StuckAgentBugReportClaim | null> {
  const request = { agentId, source: 'stuck_24h', attempts: 1, ...launch };
  const rows = await prisma.$queryRaw<Array<{ externalId: string | null; request: unknown }>>(
    Prisma.sql`
    INSERT INTO "ToolSideEffect"
      (id, "operationKey", "operationType", status, "externalId", request, "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${agentBugReportKey(agentId)}, ${AGENT_BUG_REPORT_OPERATION_TYPE},
       'STARTED', ${ownerId}, ${JSON.stringify(request)}::jsonb, ${claimedAt}, ${claimedAt})
    ON CONFLICT ("operationKey") DO UPDATE SET
      status = 'STARTED',
      "externalId" = EXCLUDED."externalId",
      request = EXCLUDED.request || COALESCE("ToolSideEffect".request, '{}'::jsonb)
        || jsonb_build_object(
          'attempts', COALESCE(("ToolSideEffect".request->>'attempts')::int, 0) + 1,
          'nextAttemptAt', NULL),
      error = NULL,
      "updatedAt" = EXCLUDED."updatedAt"
    WHERE ${reclaimableSql('ToolSideEffect', now, staleBefore)}
    RETURNING "externalId", request
  `
  );
  const row = rows[0];
  if (row?.externalId !== ownerId) return null;
  const stored = (row.request ?? {}) as Partial<StuckAgentBugReportClaim>;
  return {
    name: typeof stored.name === 'string' ? stored.name : launch.name,
    promptText: typeof stored.promptText === 'string' ? stored.promptText : launch.promptText,
    attempts: typeof stored.attempts === 'number' ? stored.attempts : 1,
  };
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
      updatedAt: now,
    },
  });
  return result.count === 1;
}

/** Record a failed launch and when it may be retried. */
export async function markStuckAgentBugReportFailed(
  agentId: string,
  ownerId: string,
  error: string,
  nextAttemptAt: Date
): Promise<void> {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE "ToolSideEffect" SET
      status = 'FAILED',
      error = ${error.slice(0, 2000)},
      request = COALESCE(request, '{}'::jsonb)
        || jsonb_build_object('nextAttemptAt', ${nextAttemptAt.toISOString()}::text),
      "updatedAt" = now()
    WHERE "operationKey" = ${agentBugReportKey(agentId)}
      AND status = 'STARTED' AND "externalId" = ${ownerId}
  `);
}

/** Stuck-agent reports attempted in [since, until] (launched or in flight), for the daily cap. */
export async function countStuckAgentBugReportsBetween(since: Date, until: Date): Promise<number> {
  return prisma.toolSideEffect.count({
    where: {
      operationType: AGENT_BUG_REPORT_OPERATION_TYPE,
      updatedAt: { gte: since, lte: until },
      status: { in: ['STARTED', 'SUCCEEDED'] },
      request: { path: ['source'], equals: 'stuck_24h' },
    },
  });
}

/** A manual Report Bug or report_bug tool launch also marks the agent reported. */
export async function recordManualAgentBugReport(
  agentId: string,
  runId: string,
  source: Exclude<AgentBugReportSource, 'stuck_24h'> = 'manual'
): Promise<void> {
  const now = new Date();
  const request = { agentId, source, runId };
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

export interface AgentSelfBugReportRequest {
  name: string;
  promptText: string;
  idempotencyKey: string;
}

export interface AgentSelfBugReportClaim extends AgentSelfBugReportRequest {
  status: string;
  runId: string | null;
}

function selfClaimFromRow(row: {
  status: string;
  externalId: string | null;
  request: unknown;
}): AgentSelfBugReportClaim | null {
  const stored = (row.request ?? {}) as Partial<AgentSelfBugReportRequest>;
  if (
    typeof stored.name !== 'string' ||
    typeof stored.promptText !== 'string' ||
    typeof stored.idempotencyKey !== 'string'
  ) {
    return null;
  }
  return {
    name: stored.name,
    promptText: stored.promptText,
    idempotencyKey: stored.idempotencyKey,
    status: row.status,
    runId: row.status === 'SUCCEEDED' ? row.externalId : null,
  };
}

/** The agent's report_bug claim, or null when it has not reported yet. */
export async function findAgentSelfBugReport(
  agentId: string
): Promise<AgentSelfBugReportClaim | null> {
  const row = await prisma.toolSideEffect.findUnique({
    where: { operationKey: agentSelfBugReportKey(agentId) },
    select: { status: true, externalId: true, request: true },
  });
  return row === null ? null : selfClaimFromRow(row);
}

/**
 * Freeze the agent's one report_bug request. A concurrent first call keeps the
 * row the winner inserted; both callers then send that same request.
 */
export async function claimAgentSelfBugReport(
  agentId: string,
  launch: AgentSelfBugReportRequest,
  now: Date
): Promise<AgentSelfBugReportClaim> {
  const request = { agentId, source: 'agent', ...launch };
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "ToolSideEffect"
      (id, "operationKey", "operationType", status, request, "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${agentSelfBugReportKey(agentId)}, ${AGENT_SELF_BUG_REPORT_OPERATION_TYPE},
       'STARTED', ${JSON.stringify(request)}::jsonb, ${now}, ${now})
    ON CONFLICT ("operationKey") DO NOTHING
  `);
  const claim = await findAgentSelfBugReport(agentId);
  if (claim === null) throw new Error(`report_bug claim for ${agentId} is missing or malformed`);
  return claim;
}

export async function markAgentSelfBugReportLaunched(
  agentId: string,
  runId: string
): Promise<void> {
  await prisma.toolSideEffect.updateMany({
    where: { operationKey: agentSelfBugReportKey(agentId), status: { not: 'SUCCEEDED' } },
    data: { status: 'SUCCEEDED', externalId: runId, response: { runId }, error: null },
  });
}

export async function markAgentSelfBugReportFailed(agentId: string, error: string): Promise<void> {
  await prisma.toolSideEffect.updateMany({
    where: { operationKey: agentSelfBugReportKey(agentId), status: { not: 'SUCCEEDED' } },
    data: { status: 'FAILED', error: error.slice(0, 2000) },
  });
}

/** report_bug claims first made in [since, until], for the tool's daily cap. */
export async function countAgentSelfBugReportsBetween(since: Date, until: Date): Promise<number> {
  return prisma.toolSideEffect.count({
    where: {
      operationType: AGENT_SELF_BUG_REPORT_OPERATION_TYPE,
      createdAt: { gte: since, lte: until },
    },
  });
}
