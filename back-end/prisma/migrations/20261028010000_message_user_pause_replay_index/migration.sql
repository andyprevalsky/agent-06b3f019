-- The incremental message poll ORs new timestamps with late user-pause
-- annotations. Without this branch index, a long agent transcript scans all
-- older messages on every poll even when the cursor is recent.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Message_userPauseReplay_idx"
ON "Message" ("agentId", "role", (metadata #> ARRAY['userPause', 'recordedAt']::text[]));
