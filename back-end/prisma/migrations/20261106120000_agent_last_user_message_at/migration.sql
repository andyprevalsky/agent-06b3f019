-- The sidebar orders each list by run state, then by the newest message a
-- person sent the agent. A column, not a per-poll Message scan: the list is
-- polled every 10s and must not cost O(agents x messages) per read.
ALTER TABLE "Agent" ADD COLUMN "lastUserMessageAt" TIMESTAMP(3);

-- Backfill the live sidebar roots from their newest USER row that no agent
-- authored (the same metadata flags the write path excludes). Each lookup walks
-- the existing ("agentId", "timestamp") index backwards and stops at the first hit.
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
