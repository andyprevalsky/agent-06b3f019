ALTER TABLE "Agent"
ADD COLUMN IF NOT EXISTS "workflowIterationOffset" INTEGER NOT NULL DEFAULT 0;

-- Existing open workflows predate the explicit checkpoint. Reconstruct a
-- conservative execute-phase high-water from their durable billed calls:
-- explicit iterations win when present; otherwise the larger execute/verifier
-- call count is the completed-turn lower bound. PLAN usage is intentionally
-- excluded because PLAN and EXECUTE have independent iteration budgets.
WITH llm_items AS (
  SELECT
    usage."agentId",
    usage."toolName",
    item
  FROM "ToolUsage" usage
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(usage."usageItems") = 'array' THEN usage."usageItems"
      ELSE '[]'::jsonb
    END
  ) item
  WHERE usage."agentId" IS NOT NULL
    AND usage."toolName" IN ('execute_loop', 'verifier_execute')
    AND item->>'type' = 'llm'
),
high_water AS (
  SELECT
    "agentId",
    COALESCE(
      MAX(
        CASE
          WHEN item->>'iteration' ~ '^[0-9]+$'
            THEN LEAST((item->>'iteration')::numeric, 2147483647)::integer
          ELSE NULL
        END
      ),
      0
    ) AS explicit_iteration,
    COUNT(*) FILTER (WHERE "toolName" = 'execute_loop')::integer AS execute_calls,
    COUNT(*) FILTER (WHERE "toolName" = 'verifier_execute')::integer AS verifier_calls
  FROM llm_items
  GROUP BY "agentId"
)
UPDATE "Agent" agent
SET "workflowIterationOffset" = GREATEST(
  agent."workflowIterationOffset",
  high_water.explicit_iteration,
  high_water.execute_calls,
  high_water.verifier_calls
)
FROM high_water
WHERE agent.id = high_water."agentId"
  AND agent.status NOT IN ('COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus");
