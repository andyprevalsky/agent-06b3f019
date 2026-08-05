import { prisma } from '../../providers/database';
import { CHAT_ONLY_TOOL_NAMES, readStoredRootCostTelemetry } from './costTelemetry';
import type { RootAgentRunRecord, RootAgentRunUsageRecord } from './types';

interface RootAgentRunUsageRawRow {
  taskId: string;
  kind: string;
  model: string;
  fromFastCache: boolean;
  tokensIn: unknown;
  cacheReadInputTokens: unknown;
  cacheCreationInputTokens: unknown;
  tokensOut: unknown;
  costCents: unknown;
}

/**
 * A cost sample is a root agent that actually entered the agent loop. Chat-only
 * setup rows are not runs. Real-model benchmarks are included because they
 * consume the same production resources; simulated world-model runs are not.
 */
export async function findRootAgentRunsBetween(
  start: Date,
  end: Date
): Promise<RootAgentRunRecord[]> {
  const [liveRuns, archivedRuns] = await Promise.all([
    prisma.agent.findMany({
      where: {
        parentAgentId: null,
        // Root means depth 0 as well: a handful of production agents have a null
        // parent without being depth 0, and they are not root runs.
        depth: 0,
        worldModelMode: 'real',
        createdAt: { gte: start, lt: end },
        toolUsages: { some: { toolName: { notIn: [...CHAT_ONLY_TOOL_NAMES] } } },
      },
      select: { id: true, createdAt: true },
    }),
    prisma.goalHistory.findMany({
      where: {
        depth: 0,
        worldModelMode: 'real',
        wasAgentRun: true,
        agentCreatedAt: { gte: start, lt: end },
      },
      select: { originalAgentId: true, agentCreatedAt: true },
    }),
  ]);
  const runs = new Map<string, RootAgentRunRecord>();
  for (const run of archivedRuns) {
    runs.set(run.originalAgentId, {
      taskId: run.originalAgentId,
      createdAt: run.agentCreatedAt,
    });
  }
  for (const run of liveRuns) runs.set(run.id, { taskId: run.id, createdAt: run.createdAt });
  return [...runs.values()];
}

async function findLiveRootAgentRunUsageBetween(
  start: Date,
  end: Date
): Promise<RootAgentRunUsageRecord[]> {
  const rows = await prisma.$queryRaw<RootAgentRunUsageRawRow[]>`
      WITH task_usage_items AS (
        SELECT
          agent.id AS "taskId",
          COALESCE(NULLIF(item.value->>'type', ''), 'unknown') AS kind,
          COALESCE(
            NULLIF(item.value->>'model', ''),
            CASE
              WHEN usage."toolName" IN ('chat_router', 'chat_generator') THEN 'zai-glm-4.7'
              ELSE 'unknown'
            END
          ) AS model,
          COALESCE(item.value->>'from_fast_cache', 'false') = 'true' AS "fromFastCache",
          CASE WHEN jsonb_typeof(item.value->'tokens_in') = 'number'
            THEN (item.value->>'tokens_in')::numeric ELSE 0 END AS "tokensIn",
          CASE WHEN jsonb_typeof(item.value->'cache_read_input_tokens') = 'number'
            THEN (item.value->>'cache_read_input_tokens')::numeric ELSE 0 END
            AS "cacheReadInputTokens",
          CASE WHEN jsonb_typeof(item.value->'cache_creation_input_tokens') = 'number'
            THEN (item.value->>'cache_creation_input_tokens')::numeric ELSE 0 END
            AS "cacheCreationInputTokens",
          CASE WHEN jsonb_typeof(item.value->'tokens_out') = 'number'
            THEN (item.value->>'tokens_out')::numeric ELSE 0 END AS "tokensOut",
          CASE WHEN jsonb_typeof(item.value->'cost_cents') = 'number'
            THEN (item.value->>'cost_cents')::numeric ELSE 0 END AS "costCents"
        FROM "ToolUsage" AS usage
        INNER JOIN "Agent" AS agent ON agent.id = usage."agentId"
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(usage."usageItems") = 'array' THEN usage."usageItems"
            ELSE '[]'::jsonb
          END
        ) AS item(value)
        WHERE agent."parentAgentId" IS NULL
          AND agent."depth" = 0
          AND agent."worldModelMode" = 'real'
          AND agent."createdAt" >= ${start}
          AND agent."createdAt" < ${end}
      )
      SELECT
        "taskId", kind, model, "fromFastCache",
        SUM("tokensIn") AS "tokensIn",
        SUM("cacheReadInputTokens") AS "cacheReadInputTokens",
        SUM("cacheCreationInputTokens") AS "cacheCreationInputTokens",
        SUM("tokensOut") AS "tokensOut",
        SUM("costCents") AS "costCents"
      FROM task_usage_items
      GROUP BY "taskId", kind, model, "fromFastCache"
    `;
  return rows.map((row) => ({
    taskId: row.taskId,
    kind: row.kind,
    model: row.model,
    fromFastCache: row.fromFastCache,
    tokensIn: Number(row.tokensIn),
    cacheReadInputTokens: Number(row.cacheReadInputTokens),
    cacheCreationInputTokens: Number(row.cacheCreationInputTokens),
    tokensOut: Number(row.tokensOut),
    costCents: Number(row.costCents),
  }));
}

/** Aggregate JSON in Postgres to one compact row per root/model/type/cache combination. */
export async function findRootAgentRunUsageBetween(
  start: Date,
  end: Date
): Promise<RootAgentRunUsageRecord[]> {
  const [liveUsage, archivedRows] = await Promise.all([
    findLiveRootAgentRunUsageBetween(start, end),
    prisma.goalHistory.findMany({
      where: {
        depth: 0,
        worldModelMode: 'real',
        wasAgentRun: true,
        agentCreatedAt: { gte: start, lt: end },
      },
      select: { originalAgentId: true, costTelemetry: true },
    }),
  ]);
  const liveTaskIds = new Set(liveUsage.map((row) => row.taskId));
  // GoalHistory is not unique on originalAgentId — production holds thousands of
  // duplicate root rows for the same archived agent. Collapse to one row per task
  // (matching findRootAgentRunsBetween) so a task's usage is not counted once per
  // duplicate against a denominator that counts it once. A duplicate without
  // telemetry must never shadow one that carries it.
  const archivedByTaskId = new Map<string, (typeof archivedRows)[number]>();
  for (const row of archivedRows) {
    const existing = archivedByTaskId.get(row.originalAgentId);
    if (existing === undefined || (existing.costTelemetry === null && row.costTelemetry !== null)) {
      archivedByTaskId.set(row.originalAgentId, row);
    }
  }
  const archivedUsage = [...archivedByTaskId.values()].flatMap((row) =>
    liveTaskIds.has(row.originalAgentId)
      ? []
      : readStoredRootCostTelemetry(row.originalAgentId, row.costTelemetry)
  );
  return [...liveUsage, ...archivedUsage];
}
