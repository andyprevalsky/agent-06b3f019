-- The sidebar orders each list by run state, then by the newest message a
-- person sent the agent. A column, not a per-poll Message scan: the list is
-- polled every 10s and must not cost O(agents x messages) per read.
ALTER TABLE "Agent" ADD COLUMN "lastUserMessageAt" TIMESTAMP(3);

-- Backfill the live sidebar roots (334 in prod on 2026-11-06) from their
-- newest USER row without an agent-authored flag. Each lookup walks the
-- ("agentId", "timestamp") index backwards and filters role/metadata per row,
-- so it reads every newer TOOL/ASSISTANT row of that root; the run is bounded
-- by the live roots' messages and locks only those root rows. Goal and
-- attachment rows count (both carry their message's own time).
UPDATE "Agent" a
SET "lastUserMessageAt" = (
  SELECT m."timestamp"
  FROM "Message" m
  WHERE m."agentId" = a.id
    AND m.role = 'USER'
    AND NOT (
      COALESCE(m.metadata, '{}'::jsonb)
        ?| ARRAY['agentMessage', 'agentNotification', 'environmentContext', 'compactionSummary']
    )
  ORDER BY m."timestamp" DESC
  LIMIT 1
)
WHERE a."parentAgentId" IS NULL
  AND a."deletedAt" IS NULL;
