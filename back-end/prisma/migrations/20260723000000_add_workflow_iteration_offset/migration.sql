ALTER TABLE "Agent"
ADD COLUMN IF NOT EXISTS "workflowIterationOffset" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Agent"
ADD COLUMN IF NOT EXISTS "temporalWorkflowStartPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "temporalWorkflowStartLeaseUntil" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "temporalCleanupPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "workflowStartPhase" TEXT,
ADD COLUMN IF NOT EXISTS "workflowTaskQueue" TEXT;

CREATE INDEX IF NOT EXISTS "Agent_temporalWorkflowStartPending_idx"
ON "Agent"("temporalWorkflowStartPending");

CREATE INDEX IF NOT EXISTS "Agent_temporalCleanupPending_id_idx"
ON "Agent"("temporalCleanupPending", id);

CREATE TABLE IF NOT EXISTS "TemporalWorkflowCleanup" (
  "agentId" TEXT NOT NULL,
  "workflowId" TEXT NOT NULL,
  "firstExecutionRunId" TEXT,
  "notBefore" TIMESTAMP(3) NOT NULL,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TemporalWorkflowCleanup_pkey" PRIMARY KEY ("agentId", "workflowId"),
  CONSTRAINT "TemporalWorkflowCleanup_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "Agent"(id) ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TemporalWorkflowCleanup_notBefore_agentId_workflowId_idx"
ON "TemporalWorkflowCleanup"("notBefore", "agentId", "workflowId");

CREATE INDEX IF NOT EXISTS "TemporalWorkflowCleanup_leaseUntil_idx"
ON "TemporalWorkflowCleanup"("leaseUntil");

ALTER TABLE "ToolUsage"
ADD COLUMN IF NOT EXISTS "operationKey" TEXT,
ADD COLUMN IF NOT EXISTS "tokenCountCheckpoint" INTEGER,
ADD COLUMN IF NOT EXISTS "tokensInCheckpoint" INTEGER,
ADD COLUMN IF NOT EXISTS "tokensOutCheckpoint" INTEGER,
ADD COLUMN IF NOT EXISTS "ownCostCheckpointCents" DOUBLE PRECISION;

CREATE UNIQUE INDEX IF NOT EXISTS "ToolUsage_operationKey_key"
ON "ToolUsage"("operationKey");

-- Protect the rolling-deploy window as well as the candidate code. Old API
-- instances do not know about the outbox columns, so the database stamps every
-- descendant workflow insert and rejects it if the producing parent generation
-- was already sealed. The advisory key is identical to
-- lockAgentWorkflowGeneration() in src/providers/workflowGeneration.ts.
CREATE OR REPLACE FUNCTION fence_descendant_workflow_start()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_parent_workflow_id TEXT;
BEGIN
  IF NEW."parentAgentId" IS NULL OR NEW."temporalWorkflowId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."parentWorkflowId" IS NULL THEN
    RAISE EXCEPTION 'parent workflow generation is required for descendant %', NEW.id
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW."parentAgentId" || ':workflow-generation',
      6901733
    )
  );

  SELECT "temporalWorkflowId"
  INTO current_parent_workflow_id
  FROM "Agent"
  WHERE id = NEW."parentAgentId"
    AND "deletedAt" IS NULL
    AND status NOT IN ('COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus");

  IF current_parent_workflow_id IS DISTINCT FROM NEW."parentWorkflowId" THEN
    RAISE EXCEPTION 'stale parent workflow generation for descendant %', NEW.id
      USING ERRCODE = '40001';
  END IF;

  NEW."temporalWorkflowStartPending" := true;
  NEW."temporalWorkflowStartLeaseUntil" := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Agent_fence_descendant_workflow_start" ON "Agent";
CREATE TRIGGER "Agent_fence_descendant_workflow_start"
BEFORE INSERT ON "Agent"
FOR EACH ROW
EXECUTE FUNCTION fence_descendant_workflow_start();

-- Persist one immutable cleanup row per workflow generation. A single stale-ID
-- slot cannot safely represent two terminal-to-chat transitions before the
-- cleanup worker runs. The grace period lets an ordinary terminal workflow
-- finish its summary/notification tail naturally; deployment-owned cleanup can
-- explicitly ignore the grace after it has fenced a frozen generation.
CREATE OR REPLACE FUNCTION enqueue_temporal_workflow_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cleanup_workflow_id TEXT;
  cleanup_first_run_id TEXT;
  should_enqueue BOOLEAN := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    should_enqueue :=
      NEW."temporalWorkflowId" IS NOT NULL
      AND (
        NEW.status IN ('COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus")
        OR NEW."deletedAt" IS NOT NULL
      );
    cleanup_workflow_id := NEW."temporalWorkflowId";
    cleanup_first_run_id := NEW."temporalFirstExecutionRunId";
  ELSE
    IF OLD."temporalWorkflowId" IS NOT NULL
       AND NEW."temporalWorkflowId" IS NULL
       AND (
         OLD.status IN (
           'COMPLETED'::"AgentStatus",
           'FAILED'::"AgentStatus",
           'COST_LIMIT_REACHED'::"AgentStatus",
           'OUT_OF_CREDITS'::"AgentStatus"
         )
         OR OLD."deletedAt" IS NOT NULL
       )
    THEN
      should_enqueue := true;
      cleanup_workflow_id := OLD."temporalWorkflowId";
      cleanup_first_run_id := OLD."temporalFirstExecutionRunId";
    ELSIF NEW."temporalWorkflowId" IS NOT NULL
       AND (
         (
           NEW.status IN ('COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus")
           AND OLD.status NOT IN ('COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus")
         )
         OR (NEW."deletedAt" IS NOT NULL AND OLD."deletedAt" IS NULL)
       )
    THEN
      should_enqueue := true;
      cleanup_workflow_id := NEW."temporalWorkflowId";
      cleanup_first_run_id := NEW."temporalFirstExecutionRunId";
    END IF;
  END IF;

  IF should_enqueue
     AND cleanup_workflow_id IS NOT NULL
     AND cleanup_workflow_id NOT LIKE '%:deployment-sealed:%'
  THEN
    INSERT INTO "TemporalWorkflowCleanup" (
      "agentId",
      "workflowId",
      "firstExecutionRunId",
      "notBefore",
      "updatedAt"
    )
    VALUES (
      NEW.id,
      cleanup_workflow_id,
      cleanup_first_run_id,
      CURRENT_TIMESTAMP + INTERVAL '5 minutes',
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("agentId", "workflowId") DO UPDATE
    SET "firstExecutionRunId" = COALESCE(
          "TemporalWorkflowCleanup"."firstExecutionRunId",
          EXCLUDED."firstExecutionRunId"
        ),
        "updatedAt" = CURRENT_TIMESTAMP;

    UPDATE "Agent"
    SET "temporalCleanupPending" = true
    WHERE id = NEW.id
      AND "temporalCleanupPending" = false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "Agent_mark_temporal_cleanup_pending" ON "Agent";
DROP TRIGGER IF EXISTS "Agent_enqueue_temporal_workflow_cleanup" ON "Agent";
CREATE TRIGGER "Agent_enqueue_temporal_workflow_cleanup"
AFTER INSERT OR UPDATE OF status, "temporalWorkflowId", "deletedAt" ON "Agent"
FOR EACH ROW
EXECUTE FUNCTION enqueue_temporal_workflow_cleanup();

-- Prefer explicit logical-iteration checkpoints. For histories written before
-- those checkpoints existed, assistant messages are the retry-stable lower
-- bound: provider/activity retries do not create extra assistant turns.
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
usage_high_water AS (
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
    ) AS explicit_iteration
  FROM llm_items
  GROUP BY "agentId"
),
assistant_turns AS (
  SELECT
    agent.id AS "agentId",
    CASE
      WHEN COUNT(message.id) FILTER (
        WHERE message."workflowGeneration" = agent."temporalWorkflowId"
      ) > 0
        THEN COUNT(message.id) FILTER (
          WHERE message."workflowGeneration" = agent."temporalWorkflowId"
        )
      ELSE COUNT(message.id) FILTER (
        WHERE message."workflowGeneration" IS NULL
      )
    END::integer AS logical_iterations
  FROM "Agent" agent
  LEFT JOIN "Message" message
    ON message."agentId" = agent.id
   AND message.role = 'ASSISTANT'::"MessageRole"
  WHERE agent.status NOT IN ('COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus")
    AND agent."temporalWorkflowId" IS NOT NULL
  GROUP BY agent.id
),
high_water AS (
  SELECT
    COALESCE(usage."agentId", turns."agentId") AS "agentId",
    GREATEST(
      COALESCE(usage.explicit_iteration, 0),
      COALESCE(turns.logical_iterations, 0)
    ) AS logical_iteration
  FROM usage_high_water usage
  FULL OUTER JOIN assistant_turns turns ON turns."agentId" = usage."agentId"
)
UPDATE "Agent" agent
SET "workflowIterationOffset" = GREATEST(
  agent."workflowIterationOffset",
  high_water.logical_iteration
)
FROM high_water
WHERE agent.id = high_water."agentId"
  AND agent.status NOT IN ('COMPLETED'::"AgentStatus", 'FAILED'::"AgentStatus");
