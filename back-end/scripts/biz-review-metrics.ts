/**
 * Read-only production metrics for /biz-review.
 *
 * Prints one JSON document for the current and previous windows:
 *   - user-initiated tasks: real, non-benchmark root agents started by a real
 *     person (operators included, fixture/test accounts excluded), counting
 *     archived (soft-deleted) agents and legacy GoalHistory archives
 *   - per-task cost (admin health `calculateTaskCostPerTask`)
 *   - recorded usage spend for every agent, split by LLM model and service
 *     provider (ToolUsage.usageItems cost_cents)
 *
 * Usage: npx tsx scripts/biz-review-metrics.ts --end 2026-10-19T19:00:00Z --days 7
 */
import 'dotenv/config';

import { Prisma } from '@prisma/client';

import { calculateTaskCostPerTask } from '../src/domains/admin-health/costs';
import {
  findRootAgentRunsBetween,
  findRootAgentRunUsageBetween,
} from '../src/domains/admin-health/costRepo';
import { ADMIN_USER_IDS } from '../src/domains/admin-health/config';
import { CHAT_ONLY_TOOL_NAMES } from '../src/domains/admin-health/costTelemetry';
import { prisma } from '../src/providers/database';
import { realWaitlistPersonSql } from '../src/providers/waitlistIdentity';

interface UsageRow {
  kind: string;
  label: string;
  items: number;
  cents: number;
  tokensOut: number;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function recordedUsage(start: Date, end: Date): Promise<UsageRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{ kind: string; label: string; items: number; cents: number; tokensOut: number }>
  >`
    WITH items AS (
      SELECT
        COALESCE(NULLIF(item.value->>'type', ''), 'unknown') AS kind,
        CASE WHEN COALESCE(item.value->>'type', '') = 'llm'
          THEN COALESCE(NULLIF(item.value->>'model', ''), 'unknown')
          ELSE COALESCE(NULLIF(item.value->>'provider', ''), 'unknown') END AS label,
        CASE WHEN jsonb_typeof(item.value->'cost_cents') = 'number'
          THEN (item.value->>'cost_cents')::numeric ELSE 0 END AS cents,
        CASE WHEN jsonb_typeof(item.value->'tokens_out') = 'number'
          THEN (item.value->>'tokens_out')::numeric ELSE 0 END AS tokens_out
      FROM "ToolUsage" AS usage
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(usage."usageItems") = 'array'
          THEN usage."usageItems" ELSE '[]'::jsonb END
      ) AS item(value)
      WHERE usage."createdAt" >= ${start} AND usage."createdAt" < ${end}
    )
    SELECT kind, label, COUNT(*)::int AS items,
           SUM(cents)::float AS cents, SUM(tokens_out)::float AS "tokensOut"
    FROM items GROUP BY kind, label ORDER BY cents DESC
  `;
  return rows.map((row) => ({
    ...row,
    cents: Number(row.cents),
    tokensOut: Number(row.tokensOut),
  }));
}

interface UserTaskRow {
  title: string;
  owner: string;
  createdAt: Date;
  status: string;
  source: string;
  archived: boolean;
  agentRun: boolean;
}

/** Root tasks real people started on prod, live and archived, one row per task. */
async function userTasks(start: Date, end: Date): Promise<UserTaskRow[]> {
  const chatOnly = Prisma.join([...CHAT_ONLY_TOOL_NAMES]);
  const admins = Prisma.join([...ADMIN_USER_IDS]);
  return prisma.$queryRaw<UserTaskRow[]>(Prisma.sql`
    WITH live AS (
      SELECT agent.id, agent."userId", COALESCE(NULLIF(agent.title, ''), agent.goal) AS title,
             agent."createdAt", agent.status::text AS status, agent.source::text AS source,
             agent."deletedAt" IS NOT NULL AS archived,
             EXISTS (SELECT 1 FROM "ToolUsage" usage WHERE usage."agentId" = agent.id
                       AND usage."toolName" NOT IN (${chatOnly})) AS "agentRun"
      FROM "Agent" agent
      WHERE agent."parentAgentId" IS NULL AND agent.depth = 0
        AND agent."isBenchmark" = false AND agent."worldModelMode" = 'real'
        AND agent."createdAt" >= ${start} AND agent."createdAt" < ${end}
    ), legacy AS (
      SELECT DISTINCT ON (history."originalAgentId")
             history."originalAgentId" AS id, history."userId", history.goal AS title,
             history."agentCreatedAt" AS "createdAt", history.status::text AS status,
             history.source::text AS source, true AS archived, history."wasAgentRun" AS "agentRun"
      FROM "GoalHistory" history
      WHERE history.depth = 0 AND history."isBenchmark" = false AND history."worldModelMode" = 'real'
        AND history."agentCreatedAt" >= ${start} AND history."agentCreatedAt" < ${end}
        AND NOT EXISTS (SELECT 1 FROM "Agent" agent WHERE agent.id = history."originalAgentId")
      ORDER BY history."originalAgentId", history."agentUpdatedAt" DESC, history.id DESC
    ), roots AS (SELECT * FROM live UNION ALL SELECT * FROM legacy)
    SELECT LEFT(roots.title, 160) AS title, COALESCE(NULLIF(person.name, ''), 'Unnamed user') AS owner,
           roots."createdAt", roots.status, roots.source, roots.archived, roots."agentRun"
    FROM roots INNER JOIN "User" person ON person."userId" = roots."userId"
    WHERE roots."userId" IN (${admins}) OR ${realWaitlistPersonSql('person')}
    ORDER BY roots."createdAt" DESC
  `);
}

function summarizeTasks(rows: UserTaskRow[]) {
  const runs = rows.filter((row) => row.agentRun);
  const completed = runs.filter((row) => row.status === 'COMPLETED').length;
  const count = (key: (row: UserTaskRow) => string) => {
    const totals: Record<string, number> = {};
    for (const row of rows) totals[key(row)] = (totals[key(row)] ?? 0) + 1;
    return totals;
  };
  return {
    total: rows.length,
    agentRuns: runs.length,
    chatOnly: rows.length - runs.length,
    completed,
    // Completion is measured over agent runs: chat-only questions never enter
    // the agent loop, so they never reach COMPLETED.
    completionRate: runs.length === 0 ? null : Number((completed / runs.length).toFixed(4)),
    bySource: count((row) => row.source),
    byUser: count((row) => row.owner),
    items: rows.map((row) => ({
      title: row.title,
      owner: row.owner,
      createdAt: row.createdAt.toISOString(),
      status: row.status,
      source: row.source,
      kind: row.agentRun ? 'agent' : 'chat',
      archived: row.archived,
    })),
  };
}

async function windowMetrics(start: Date, end: Date) {
  const [tasks, runs, runUsage, usage] = await Promise.all([
    userTasks(start, end),
    findRootAgentRunsBetween(start, end),
    findRootAgentRunUsageBetween(start, end),
    recordedUsage(start, end),
  ]);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    tasks: summarizeTasks(tasks),
    costPerTask: calculateTaskCostPerTask(runs, runUsage),
    recordedUsage: usage,
  };
}

async function main(): Promise<void> {
  const end = new Date(argValue('--end') ?? Date.now());
  const days = Number(argValue('--days') ?? '7');
  if (Number.isNaN(end.getTime()) || !Number.isFinite(days) || days <= 0) {
    throw new Error('Usage: biz-review-metrics.ts [--end ISO] [--days N]');
  }
  const span = days * 86_400_000;
  const start = new Date(end.getTime() - span);
  const [current, previous] = await Promise.all([
    windowMetrics(start, end),
    windowMetrics(new Date(start.getTime() - span), start),
  ]);
  process.stdout.write(
    `${JSON.stringify({ generatedAt: new Date().toISOString(), current, previous })}\n`
  );
}

main()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(
      `biz-review-metrics failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
