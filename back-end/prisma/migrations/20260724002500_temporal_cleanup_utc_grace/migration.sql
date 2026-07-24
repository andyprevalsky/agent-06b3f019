-- Store cleanup grace timestamps in UTC before writing them to TIMESTAMP WITHOUT TIME ZONE
-- columns. Local Postgres instances may run with a non-UTC session timezone; Prisma reads these
-- timestamp columns as UTC, so session-local CURRENT_TIMESTAMP can make a 5-minute grace period
-- look hours stale.
CREATE OR REPLACE FUNCTION enqueue_temporal_workflow_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cleanup_workflow_id TEXT;
  cleanup_first_run_id TEXT;
  should_enqueue BOOLEAN := false;
  utc_now TIMESTAMP;
BEGIN
  utc_now := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';

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
      utc_now + INTERVAL '5 minutes',
      utc_now
    )
    ON CONFLICT ("agentId", "workflowId") DO UPDATE
    SET "firstExecutionRunId" = COALESCE(
          "TemporalWorkflowCleanup"."firstExecutionRunId",
          EXCLUDED."firstExecutionRunId"
        ),
        "updatedAt" = utc_now;

    UPDATE "Agent"
    SET "temporalCleanupPending" = true
    WHERE id = NEW.id
      AND "temporalCleanupPending" = false;
  END IF;
  RETURN NEW;
END;
$$;
