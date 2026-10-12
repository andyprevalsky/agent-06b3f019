-- Root agents reuse Workflow ID = agent ID for every follow-up run, so a
-- later generation that goes terminal before an earlier generation's cleanup
-- runs lands on the same ("agentId", "workflowId") row. A different known run
-- can only start after the earlier chain closed, so the newest known run is
-- the one cleanup must target, and its own terminal tail keeps the full grace.
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
          EXCLUDED."firstExecutionRunId",
          "TemporalWorkflowCleanup"."firstExecutionRunId"
        ),
        "notBefore" = GREATEST(
          "TemporalWorkflowCleanup"."notBefore",
          EXCLUDED."notBefore"
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
