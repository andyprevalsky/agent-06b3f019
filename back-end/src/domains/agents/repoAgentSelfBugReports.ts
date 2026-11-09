/**
 * The root agent report_bug tool's own claim, one per agent run, in the shared
 * ToolSideEffect idempotency table (the stuck-agent claim lives in
 * repoAgentBugReports.ts):
 *
 *   operationKey  agent-self-bug-report:<agentId>  (unique → one tool report per run)
 *   status        STARTED / FAILED  request frozen; any retry re-sends it unchanged
 *                 SUCCEEDED         externalId = boxes.dev run id
 *                 RECORDED          saved for /rca only; nothing launched (outside production)
 */

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma, runTransactionWithRetry } from '../../providers/database';

/** Separate type so the stuck-agent daily cap and the tool's daily cap never mix. */
export const AGENT_SELF_BUG_REPORT_OPERATION_TYPE = 'AGENT_SELF_BUG_REPORT';

/** The report_bug tool's own claim key: one per agent run. */
export function agentSelfBugReportKey(agentId: string): string {
  return `agent-self-bug-report:${agentId}`;
}

export interface AgentSelfBugReportRequest {
  name: string;
  promptText: string;
  idempotencyKey: string;
  description: string;
}

export interface AgentSelfBugReportClaim extends AgentSelfBugReportRequest {
  status: string;
  runId: string | null;
}

export interface AgentSelfBugReportRow extends AgentSelfBugReportClaim {
  createdAt: Date;
  updatedAt: Date;
}

/** Read a claim row back into its frozen request; null when the row is malformed. */
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
    description: stored.description ?? '',
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

/** The tree root's report_bug row with its timestamps, for /rca reads. */
export async function findAgentSelfBugReportRow(
  agentId: string
): Promise<AgentSelfBugReportRow | null> {
  const row = await prisma.toolSideEffect.findUnique({
    where: { operationKey: agentSelfBugReportKey(agentId) },
    select: { status: true, externalId: true, request: true, createdAt: true, updatedAt: true },
  });
  const claim = row === null ? null : selfClaimFromRow(row);
  return row === null || claim === null
    ? null
    : { ...claim, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

/**
 * Save the agent's one report_bug request as RECORDED (no launch, no cap). A
 * concurrent first call keeps the row the winner inserted; both callers then
 * use that same request.
 */
export async function claimAgentSelfBugReport(
  agentId: string,
  launch: AgentSelfBugReportRequest,
  now: Date,
  status: 'STARTED' | 'RECORDED' = 'RECORDED'
): Promise<AgentSelfBugReportClaim> {
  const request = { agentId, source: 'agent', ...launch };
  await prisma.$executeRaw(Prisma.sql`
    INSERT INTO "ToolSideEffect"
      (id, "operationKey", "operationType", status, request, "createdAt", "updatedAt")
    VALUES
      (${randomUUID()}, ${agentSelfBugReportKey(agentId)}, ${AGENT_SELF_BUG_REPORT_OPERATION_TYPE},
       ${status}, ${JSON.stringify(request)}::jsonb, ${now}, ${now})
    ON CONFLICT ("operationKey") DO NOTHING
  `);
  const claim = await findAgentSelfBugReport(agentId);
  if (claim === null) throw new Error(`report_bug claim for ${agentId} is missing or malformed`);
  return claim;
}

/** Record the boxes.dev run that the frozen request launched. */
export async function markAgentSelfBugReportLaunched(
  agentId: string,
  runId: string
): Promise<void> {
  await prisma.toolSideEffect.updateMany({
    where: { operationKey: agentSelfBugReportKey(agentId), status: { in: ['STARTED', 'FAILED'] } },
    data: { status: 'SUCCEEDED', externalId: runId, response: { runId }, error: null },
  });
}

/** Keep the frozen request after a failed launch so a retry re-sends it unchanged. */
export async function markAgentSelfBugReportFailed(agentId: string, error: string): Promise<void> {
  await prisma.toolSideEffect.updateMany({
    where: { operationKey: agentSelfBugReportKey(agentId), status: { in: ['STARTED', 'FAILED'] } },
    data: { status: 'FAILED', error: error.slice(0, 2000) },
  });
}

/**
 * Freeze a launching report_bug claim only while fewer than `cap` launching
 * claims were first made since `since`. The count and insert run under one
 * advisory lock, so concurrent first reports from different agents cannot
 * overshoot the cap. The window has no upper bound: a request that takes the
 * lock after a later-stamped one still counts that claim. Returns null at the
 * cap. Only a production launch's first claim takes the lock (at most `cap`
 * per day).
 */
export async function claimAgentSelfBugReportWithinCap(
  agentId: string,
  launch: AgentSelfBugReportRequest,
  now: Date,
  cap: number,
  since: Date
): Promise<AgentSelfBugReportClaim | null> {
  const request = { agentId, source: 'agent', ...launch };
  const claimed = await runTransactionWithRetry(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${AGENT_SELF_BUG_REPORT_OPERATION_TYPE}))`;
    const existing = await tx.toolSideEffect.findUnique({
      where: { operationKey: agentSelfBugReportKey(agentId) },
      select: { id: true },
    });
    if (existing !== null) return true;
    const launched = await tx.toolSideEffect.count({
      where: {
        operationType: AGENT_SELF_BUG_REPORT_OPERATION_TYPE,
        createdAt: { gte: since },
        status: { not: 'RECORDED' },
      },
    });
    if (launched >= cap) return false;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "ToolSideEffect"
        (id, "operationKey", "operationType", status, request, "createdAt", "updatedAt")
      VALUES
        (${randomUUID()}, ${agentSelfBugReportKey(agentId)}, ${AGENT_SELF_BUG_REPORT_OPERATION_TYPE},
         'STARTED', ${JSON.stringify(request)}::jsonb, ${now}, ${now})
      ON CONFLICT ("operationKey") DO NOTHING
    `);
    return true;
  });
  if (!claimed) return null;
  const claim = await findAgentSelfBugReport(agentId);
  if (claim === null) throw new Error(`report_bug claim for ${agentId} is missing or malformed`);
  return claim;
}
